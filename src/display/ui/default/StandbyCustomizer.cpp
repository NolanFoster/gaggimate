#include "StandbyCustomizer.h"

#include <LittleFS.h>
#include <algorithm>
#include <display/core/Controller.h>
#include <display/core/StandbyImage.h>
#include <display/ui/default/eez/images.h>
#include <display/ui/default/eez/screens.h>
#include <display/ui/default/eez/ui.h>
#include <esp32-hal-psram.h>
#include <time.h>

LV_FONT_DECLARE(standby_clock_font_110);

namespace {
// Layout offsets from the screen centre (panel is 480x480, round). Stock positions come from the EEZ screen:
// logo at 0, clock at -150, status/touch icon at +150.
constexpr lv_coord_t TEMP_Y_STOCK = 62;
constexpr lv_coord_t TEMP_GAP_BELOW_LOGO = 30; // pushes the temperature below a tall custom logo
constexpr lv_coord_t LARGE_TIME_Y = -10;
constexpr lv_coord_t LARGE_AMPM_Y = 62;
constexpr lv_coord_t LARGE_TEMP_Y = 98;
// Analog clock: a full-face watch dial (radius 236 on the round 480 panel). Ticks stay outside the status icons
// (|x| >= 15, y >= -220) and the tap hint (+126..+174); logo and temperature sit in the upper and lower halves.
constexpr lv_coord_t ANALOG_SIZE = 472;
constexpr lv_coord_t ANALOG_TEMP_Y = 100;
constexpr lv_coord_t ANALOG_HOUR_HAND = -100;  // needle length relative to the dial radius
constexpr lv_coord_t ANALOG_MINUTE_HAND = -28;
constexpr unsigned long TICK_INTERVAL_MS = 1000;

// The box a logo is fitted into (never enlarged) per clock style. Sized so the stock 392x53 logo keeps its exact
// stock size (1:1), half size above the large clock, and 104/256 inside the analog dial.
struct LogoBox {
    lv_coord_t w, h, y;
};
constexpr LogoBox LOGO_BOX_STOCK{392, 160, 0};
constexpr LogoBox LOGO_BOX_LARGE{196, 60, -130};
constexpr LogoBox LOGO_BOX_ANALOG{200, 50, -100};

bool isUsable(lv_obj_t *obj) { return obj != nullptr && lv_obj_is_valid(obj); }

size_t bytesPerPixel(uint32_t cf) {
    switch (cf) {
    case LV_IMG_CF_ALPHA_8BIT:
        return 1;
    case LV_IMG_CF_TRUE_COLOR:
        return LV_COLOR_SIZE / 8;
    default: // LV_IMG_CF_TRUE_COLOR_ALPHA
        return LV_IMG_PX_SIZE_ALPHA_BYTE;
    }
}

// Reads `bytes` of pixels into PSRAM; nullptr on any failure.
uint8_t *readPixels(File &file, size_t bytes) {
    auto *pixels = static_cast<uint8_t *>(ps_malloc(bytes));
    if (pixels != nullptr && file.read(pixels, bytes) != bytes) {
        free(pixels);
        pixels = nullptr;
    }
    return pixels;
}
} // namespace

void StandbyCustomizer::loadPending() {
    loadImage();
    loadLogo();
}

// Anything unexpected (missing, wrong size, bad header, no PSRAM) loads as "none": the stock look.
void StandbyCustomizer::loadImage() {
    const int rev = controller->getSettings().getStandbyImageRev();
    if (rev == imageSlot.loaderRev)
        return;
    imageSlot.loaderRev = rev;

    Asset asset;
    if (File file = LittleFS.open(standby_image::PATH, "r")) {
        uint32_t header = 0;
        if (file.size() == standby_image::FILE_BYTES &&
            file.read(reinterpret_cast<uint8_t *>(&header), sizeof(header)) == sizeof(header) && header == standby_image::HEADER) {
            asset = {readPixels(file, standby_image::PIXEL_BYTES), LV_IMG_CF_TRUE_COLOR, standby_image::SIZE,
                     standby_image::SIZE};
        } else {
            ESP_LOGW("StandbyCustomizer", "Ignoring invalid standby image");
        }
        file.close();
    }
    publish(imageSlot, asset);
}

void StandbyCustomizer::loadLogo() {
    const int rev = controller->getSettings().getStandbyLogoRev();
    if (rev == logoSlot.loaderRev)
        return;
    logoSlot.loaderRev = rev;

    Asset asset;
    if (File file = LittleFS.open(standby_logo::PATH, "r")) {
        uint32_t raw = 0;
        standby_logo::Header header;
        if (file.read(reinterpret_cast<uint8_t *>(&raw), sizeof(raw)) == sizeof(raw) &&
            standby_logo::parseHeader(raw, file.size(), header)) {
            const size_t bytes = static_cast<size_t>(header.w) * header.h * standby_logo::bytesPerPixel(header.cf);
            asset = {readPixels(file, bytes), header.cf, header.w, header.h};
        } else {
            ESP_LOGW("StandbyCustomizer", "Ignoring invalid standby logo");
        }
        file.close();
    }
    if (asset.pixels == nullptr)
        asset = {};
    publish(logoSlot, asset);
}

void StandbyCustomizer::publish(Slot &slot, const Asset &asset) {
    std::lock_guard<std::mutex> guard(slotMutex);
    free(slot.pending.pixels);
    slot.pending = asset;
    slot.pendingValid = true;
}

// UI task: adopts a newly loaded file. `user` is the object drawing the old pixels; it goes before they are freed
// (LVGL keeps no image cache: LV_IMG_CACHE_DEF_SIZE 0).
bool StandbyCustomizer::take(Slot &slot, lv_obj_t *&user) {
    Asset asset;
    {
        std::lock_guard<std::mutex> guard(slotMutex);
        if (!slot.pendingValid)
            return false;
        asset = slot.pending;
        slot.pending = {};
        slot.pendingValid = false;
    }
    if (isUsable(user))
        lv_obj_del(user);
    user = nullptr;
    free(slot.shown.pixels);
    slot.shown = asset;
    slot.dsc = {};
    if (asset.pixels != nullptr) {
        slot.dsc.header.cf = asset.cf;
        slot.dsc.header.w = asset.w;
        slot.dsc.header.h = asset.h;
        slot.dsc.data_size = asset.w * asset.h * bytesPerPixel(asset.cf);
        slot.dsc.data = asset.pixels;
    }
    return true;
}

void StandbyCustomizer::loop(bool onStandby) {
    if (take(imageSlot, background))
        applied = {}; // force a full re-apply
    if (take(logoSlot, ownLogo)) {
        logoGeneration++;
        applied = {};
    }
    if (!isUsable(objects.standby_screen) || !isUsable(objects.time) || !isUsable(objects.obj3))
        return;

    const Settings &settings = controller->getSettings();
    Applied want;
    want.screen = objects.standby_screen;
    want.clockStyle = settings.getStandbyClockStyle();
    if (want.clockStyle < STANDBY_CLOCK_DIGITAL || want.clockStyle > STANDBY_CLOCK_HIDDEN)
        want.clockStyle = STANDBY_CLOCK_DIGITAL;
    want.showLogo = settings.isStandbyShowLogo();
    want.showTemp = settings.isStandbyShowTemp();
    want.image = imageSlot.shown.pixels;
    want.logo = logoSlot.shown.pixels;
    want.theme = eez_flow_get_selected_theme_index();
    want.dim = settings.getStandbyImageDim();

    if (!(want == applied)) {
        if (want.screen != capturedScreen)
            captureStock();
        reset();
        apply(want);
        applied = want;
    }

    if (onStandby && millis() - lastTick >= TICK_INTERVAL_MS) {
        lastTick = millis();
        updateClock(false);
        updateTemperature(false);
    }
}

// Records the stock values of the EEZ objects this class changes, so reset() can put them back exactly.
void StandbyCustomizer::captureStock() {
    capturedScreen = objects.standby_screen;
    stockLogoY = lv_obj_get_style_y(objects.obj3, LV_PART_MAIN);
    // A new screen object means the old one (and our children) is gone.
    background = bigTime = ampm = meter = tempLabel = ownLogo = nullptr;
    hourNeedle = minuteNeedle = nullptr;
}

void StandbyCustomizer::reset() {
    for (lv_obj_t **obj : {&background, &bigTime, &ampm, &meter, &tempLabel, &ownLogo}) {
        if (isUsable(*obj))
            lv_obj_del(*obj);
        *obj = nullptr;
    }
    hourNeedle = minuteNeedle = nullptr;

    // Only properties EEZ never sets are removed (opacity, icon border opacity); the rest go back to captured values.
    lv_obj_t *logo = objects.obj3;
    lv_obj_remove_local_style_prop(logo, LV_STYLE_OPA, LV_PART_MAIN);
    lv_obj_set_y(logo, stockLogoY);
    lv_obj_remove_local_style_prop(objects.time, LV_STYLE_OPA, LV_PART_MAIN);
    setIconBordersTransparent(false);
    shownMinute = -1;
    shownTemp = INT32_MIN;
}

void StandbyCustomizer::apply(const Applied &want) {
    lv_obj_t *screen = want.screen;
    const bool image = want.image != nullptr;
    const bool customLogo = want.logo != nullptr;
    const lv_color_t fg = lv_color_hex(theme_colors[want.theme][0]);
    uint32_t nextIndex = 0; // our layers go beneath the EEZ widgets, in this order

    if (image) {
        background = lv_img_create(screen);
        lv_obj_add_flag(background, LV_OBJ_FLAG_USER_1);
        lv_obj_clear_flag(background, LV_OBJ_FLAG_CLICKABLE);
        lv_img_set_src(background, &imageSlot.dsc);
        lv_obj_align(background, LV_ALIGN_CENTER, 0, 0);
        // Tint the photo toward the theme background so the clock and logo stay readable on top of it.
        lv_obj_set_style_img_recolor(background, lv_color_hex(theme_colors[want.theme][1]), LV_PART_MAIN);
        lv_obj_set_style_img_recolor_opa(background, static_cast<lv_opa_t>(want.dim * 255 / 100), LV_PART_MAIN);
        lv_obj_move_to_index(background, nextIndex++);
    }

    LogoBox logoBox = LOGO_BOX_STOCK;
    lv_coord_t tempY = TEMP_Y_STOCK;
    switch (want.clockStyle) {
    case STANDBY_CLOCK_LARGE:
        lv_obj_set_style_opa(objects.time, LV_OPA_TRANSP, LV_PART_MAIN);
        bigTime = createLabel(screen, &standby_clock_font_110, LARGE_TIME_Y);
        ampm = createLabel(screen, &lv_font_montserrat_24, LARGE_AMPM_Y);
        logoBox = LOGO_BOX_LARGE;
        tempY = LARGE_TEMP_Y;
        break;
    case STANDBY_CLOCK_ANALOG: {
        lv_obj_set_style_opa(objects.time, LV_OPA_TRANSP, LV_PART_MAIN);
        meter = lv_meter_create(screen);
        lv_obj_add_flag(meter, LV_OBJ_FLAG_USER_1);
        lv_obj_clear_flag(meter, LV_OBJ_FLAG_CLICKABLE);
        lv_obj_set_size(meter, ANALOG_SIZE, ANALOG_SIZE);
        lv_obj_align(meter, LV_ALIGN_CENTER, 0, 0);
        lv_obj_set_style_border_width(meter, 0, LV_PART_MAIN);
        lv_obj_set_style_bg_opa(meter, LV_OPA_TRANSP, LV_PART_MAIN);
        lv_obj_set_style_pad_all(meter, 0, LV_PART_MAIN);
        lv_obj_set_style_text_opa(meter, LV_OPA_TRANSP, LV_PART_TICKS); // no numbers on the dial
        lv_obj_set_style_bg_color(meter, fg, LV_PART_INDICATOR);
        lv_obj_set_style_width(meter, 18, LV_PART_INDICATOR); // centre cap
        lv_obj_set_style_height(meter, 18, LV_PART_INDICATOR);
        lv_obj_set_style_line_rounded(meter, true, LV_PART_ITEMS); // rounded hands
        // Minute ticks with an hour marker every fifth, plus bolder quarter markers (12/3/6/9) on a second scale.
        lv_meter_scale_t *scale = lv_meter_add_scale(meter);
        lv_meter_set_scale_ticks(meter, scale, 61, 2, 8, fg);
        lv_meter_set_scale_major_ticks(meter, scale, 5, 4, 18, fg, 10);
        lv_meter_set_scale_range(meter, scale, 0, 60, 360, 270);
        lv_meter_scale_t *quarters = lv_meter_add_scale(meter);
        lv_meter_set_scale_ticks(meter, quarters, 5, 7, 26, fg);
        lv_meter_set_scale_major_ticks(meter, quarters, 1, 7, 26, fg, 10);
        lv_meter_set_scale_range(meter, quarters, 0, 60, 360, 270);
        hourNeedle = lv_meter_add_needle_line(meter, scale, 10, fg, ANALOG_HOUR_HAND);
        minuteNeedle = lv_meter_add_needle_line(meter, scale, 6, fg, ANALOG_MINUTE_HAND);
        lv_obj_move_to_index(meter, nextIndex++);
        logoBox = LOGO_BOX_ANALOG;
        tempY = ANALOG_TEMP_Y;
        break;
    }
    case STANDBY_CLOCK_HIDDEN:
        lv_obj_set_style_opa(objects.time, LV_OPA_TRANSP, LV_PART_MAIN);
        break;
    default: // STANDBY_CLOCK_DIGITAL: the stock EEZ clock
        break;
    }

    // The EEZ logo stays only for the stock look; a scaled or custom logo is drawn by us (on top of the dial).
    const bool scaledLayout = want.clockStyle == STANDBY_CLOCK_LARGE || want.clockStyle == STANDBY_CLOCK_ANALOG;
    if (!want.showLogo || customLogo || scaledLayout)
        lv_obj_set_style_opa(objects.obj3, LV_OPA_TRANSP, LV_PART_MAIN);
    if (want.showLogo && (customLogo || scaledLayout)) {
        lv_coord_t logoHeight = 0;
        ownLogo = createLogo(screen, fg, logoBox.w, logoBox.h, logoBox.y, logoHeight);
        if (ownLogo != nullptr && !scaledLayout)
            tempY = std::max<lv_coord_t>(TEMP_Y_STOCK, logoHeight / 2 + TEMP_GAP_BELOW_LOGO);
    }

    if (image)
        setIconBordersTransparent(true);

    if (want.showTemp)
        tempLabel = createLabel(screen, &lv_font_montserrat_24, tempY);

    // Watch hands go over everything; the meter isn't clickable, so taps still reach the screen (tap to wake).
    if (meter != nullptr)
        lv_obj_move_foreground(meter);

    updateClock(true);
    updateTemperature(true);
}

// Fits the custom logo (or the stock one) into the box, never enlarging it; `height` gets the drawn height.
lv_obj_t *StandbyCustomizer::createLogo(lv_obj_t *parent, lv_color_t color, lv_coord_t boxW, lv_coord_t boxH,
                                        lv_coord_t y, lv_coord_t &height) {
    const Asset &custom = logoSlot.shown;
    const lv_img_dsc_t *src;
    uint32_t w, h;
    if (custom.pixels != nullptr) {
        w = custom.w;
        h = custom.h;
        src = custom.cf == standby_logo::CF_TRUE_COLOR_ALPHA ? &logoSlot.dsc
                                                             : tintedLogo(custom.pixels, w, h, logoGeneration, color);
    } else {
        w = img_logo.header.w;
        h = img_logo.header.h;
        src = tintedLogo(img_logo.data, w, h, UINT32_MAX - 1, color); // stock logo id
    }
    if (src == nullptr)
        return nullptr; // no PSRAM: the layout just goes without a logo

    const uint32_t zoom = std::max<uint32_t>(
        1, std::min<uint32_t>({LV_IMG_ZOOM_NONE, static_cast<uint32_t>(boxW) * LV_IMG_ZOOM_NONE / w,
                               static_cast<uint32_t>(boxH) * LV_IMG_ZOOM_NONE / h}));
    height = static_cast<lv_coord_t>(h * zoom / LV_IMG_ZOOM_NONE);

    lv_obj_t *img = lv_img_create(parent);
    lv_obj_add_flag(img, LV_OBJ_FLAG_USER_1);
    lv_obj_clear_flag(img, LV_OBJ_FLAG_CLICKABLE);
    lv_img_set_src(img, src);
    lv_img_set_size_mode(img, LV_IMG_SIZE_MODE_REAL); // the object follows the zoomed size, so centring holds
    lv_img_set_antialias(img, true);
    lv_img_set_zoom(img, static_cast<uint16_t>(zoom));
    lv_obj_align(img, LV_ALIGN_CENTER, 0, y);
    return img;
}

// Full-colour copy of an alpha-only logo in `color`, cached per (source, colour).
const lv_img_dsc_t *StandbyCustomizer::tintedLogo(const uint8_t *alpha, uint32_t w, uint32_t h, uint32_t sourceId,
                                                  lv_color_t color) {
    const size_t bytes = static_cast<size_t>(w) * h * LV_IMG_PX_SIZE_ALPHA_BYTE;
    if (tintPixels == nullptr || tintBytes < bytes) {
        free(tintPixels);
        tintPixels = static_cast<uint8_t *>(ps_malloc(bytes));
        tintBytes = tintPixels != nullptr ? bytes : 0;
        tintSource = UINT32_MAX;
        if (tintPixels == nullptr)
            return nullptr;
    }
    if (tintSource != sourceId || tintColor != lv_color_to32(color) || tintDsc.header.w != w || tintDsc.header.h != h) {
        tintSource = sourceId;
        tintColor = lv_color_to32(color);
        for (size_t i = 0; i < static_cast<size_t>(w) * h; i++) {
            uint8_t *px = tintPixels + i * LV_IMG_PX_SIZE_ALPHA_BYTE;
            memcpy(px, &color.full, sizeof(color.full));
            px[LV_IMG_PX_SIZE_ALPHA_BYTE - 1] = alpha[i];
        }
        tintDsc = {};
        tintDsc.header.cf = LV_IMG_CF_TRUE_COLOR_ALPHA;
        tintDsc.header.w = w;
        tintDsc.header.h = h;
        tintDsc.data_size = bytes;
        tintDsc.data = tintPixels;
    }
    return &tintDsc;
}

lv_obj_t *StandbyCustomizer::createLabel(lv_obj_t *parent, const lv_font_t *font, lv_coord_t y) {
    lv_obj_t *label = lv_label_create(parent);
    lv_obj_add_flag(label, LV_OBJ_FLAG_USER_1);
    lv_obj_clear_flag(label, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_set_style_text_font(label, font, LV_PART_MAIN);
    lv_obj_set_style_text_color(label, lv_color_hex(theme_colors[eez_flow_get_selected_theme_index()][0]), LV_PART_MAIN);
    lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_CENTER, LV_PART_MAIN);
    lv_label_set_text(label, "");
    lv_obj_align(label, LV_ALIGN_CENTER, 0, y);
    return label;
}

// The status icons are spaced by a 10px border in the background colour, which shows as a dark box over a photo.
void StandbyCustomizer::setIconBordersTransparent(bool on) const {
    for (lv_obj_t *icon : {objects.wifi_icon, objects.bluetooth_icon, objects.update_icon}) {
        if (!isUsable(icon))
            continue;
        if (on)
            lv_obj_set_style_border_opa(icon, LV_OPA_TRANSP, LV_PART_MAIN);
        else
            lv_obj_remove_local_style_prop(icon, LV_STYLE_BORDER_OPA, LV_PART_MAIN);
    }
}

void StandbyCustomizer::updateClock(bool force) {
    if (bigTime == nullptr && meter == nullptr)
        return;
    struct tm now;
    const bool known = getLocalTime(&now, 5);
    const int minute = known ? now.tm_hour * 60 + now.tm_min : -2;
    if (!force && minute == shownMinute)
        return;
    shownMinute = minute;

    if (bigTime != nullptr) {
        char timeBuf[8] = "";
        char ampmBuf[4] = "";
        if (known) {
            if (controller->getSettings().isClock24hFormat()) {
                strftime(timeBuf, sizeof(timeBuf), "%H:%M", &now);
            } else {
                const int hour12 = now.tm_hour % 12 == 0 ? 12 : now.tm_hour % 12;
                snprintf(timeBuf, sizeof(timeBuf), "%d:%02d", hour12, now.tm_min);
                strftime(ampmBuf, sizeof(ampmBuf), "%p", &now);
            }
        }
        lv_label_set_text(bigTime, timeBuf);
        if (ampm != nullptr) {
            lv_label_set_text(ampm, ampmBuf);
            // Hidden while empty (24h format), so nothing reserves its line.
            if (ampmBuf[0] == '\0')
                lv_obj_add_flag(ampm, LV_OBJ_FLAG_HIDDEN);
            else
                lv_obj_clear_flag(ampm, LV_OBJ_FLAG_HIDDEN);
        }
        if (timeBuf[0] == '\0')
            lv_obj_add_flag(bigTime, LV_OBJ_FLAG_HIDDEN);
        else
            lv_obj_clear_flag(bigTime, LV_OBJ_FLAG_HIDDEN);
    }

    if (meter != nullptr) {
        // Without a clock (no NTP yet) the hands stay hidden rather than showing a wrong time.
        const lv_opa_t opa = known ? LV_OPA_COVER : LV_OPA_TRANSP;
        hourNeedle->opa = opa;
        minuteNeedle->opa = opa;
        if (known) {
            lv_meter_set_indicator_value(meter, hourNeedle, (now.tm_hour % 12) * 5 + now.tm_min / 12);
            lv_meter_set_indicator_value(meter, minuteNeedle, now.tm_min);
        }
        lv_obj_invalidate(meter);
    }
}

void StandbyCustomizer::updateTemperature(bool force) {
    if (tempLabel == nullptr)
        return;
    const int temp = static_cast<int>(lroundf(controller->getCurrentTemp()));
    if (!force && temp == shownTemp)
        return;
    shownTemp = temp;
    char buf[12];
    snprintf(buf, sizeof(buf), "%d°C", temp);
    lv_label_set_text(tempLabel, buf);
}
