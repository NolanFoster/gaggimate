#ifndef STANDBYCUSTOMIZER_H
#define STANDBYCUSTOMIZER_H

#include <cstdint>
#include <lvgl.h>
#include <mutex>

class Controller;

// Layers the user's standby customization (background image, custom logo, clock style, logo, temperature) on top of
// the EEZ-generated standby screen without editing it. Every apply() first undoes what it did before, so with the
// default settings the screen is exactly the stock one.
//
// Objects it creates carry LV_OBJ_FLAG_USER_1 so DefaultUI's gauge animation ignores the analog clock meter.
class StandbyCustomizer {
  public:
    explicit StandbyCustomizer(Controller *controller) : controller(controller) {}

    // Profiles task: reads the background and logo files from flash when their revision changed (never on the UI
    // task).
    void loadPending();
    // UI task, every loop: (re)applies when settings, files, theme or the screen object changed; ticks the clock
    // and temperature while the standby screen is shown.
    void loop(bool onStandby);

  private:
    // A file loaded into PSRAM: LVGL colour format, size and pixels (nullptr = none, which means stock).
    struct Asset {
        uint8_t *pixels = nullptr;
        uint32_t cf = 0;
        uint32_t w = 0;
        uint32_t h = 0;
    };
    // Loader → UI handoff for one file.
    struct Slot {
        Asset pending;
        bool pendingValid = false;
        int loaderRev = -1; // loader-only
        Asset shown;        // UI-only
        lv_img_dsc_t dsc = {};
    };
    struct Applied {
        lv_obj_t *screen = nullptr;
        int clockStyle = -1;
        bool showLogo = true;
        bool showTemp = false;
        const uint8_t *image = nullptr;
        const uint8_t *logo = nullptr;
        uint32_t theme = UINT32_MAX;
        int dim = 0;
        bool operator==(const Applied &o) const {
            return screen == o.screen && clockStyle == o.clockStyle && showLogo == o.showLogo && showTemp == o.showTemp &&
                   image == o.image && logo == o.logo && theme == o.theme && dim == o.dim;
        }
    };

    void loadImage();
    void loadLogo();
    void publish(Slot &slot, const Asset &asset);
    bool take(Slot &slot, lv_obj_t *&user);
    void captureStock();
    void reset();
    void apply(const Applied &want);
    void updateClock(bool force);
    void updateTemperature(bool force);
    lv_obj_t *createLabel(lv_obj_t *parent, const lv_font_t *font, lv_coord_t y);
    void setIconBordersTransparent(bool on) const;
    lv_obj_t *createLogo(lv_obj_t *parent, lv_color_t color, lv_coord_t boxW, lv_coord_t boxH, lv_coord_t y,
                         lv_coord_t &height);
    const lv_img_dsc_t *tintedLogo(const uint8_t *alpha, uint32_t w, uint32_t h, uint32_t sourceId, lv_color_t color);

    Controller *controller;
    std::mutex slotMutex;
    Slot imageSlot;
    Slot logoSlot;
    uint32_t logoGeneration = 0; // bumped whenever the custom logo changes; keys the tinted copy

    // UI-only state.
    Applied applied;
    lv_obj_t *capturedScreen = nullptr;
    lv_coord_t stockLogoY = 0;

    lv_obj_t *background = nullptr;
    lv_obj_t *bigTime = nullptr;
    lv_obj_t *ampm = nullptr;
    lv_obj_t *meter = nullptr;
    lv_meter_indicator_t *hourNeedle = nullptr;
    lv_meter_indicator_t *minuteNeedle = nullptr;
    lv_obj_t *tempLabel = nullptr;
    lv_obj_t *ownLogo = nullptr; // replaces the EEZ logo when it is scaled or custom
    // Full-colour copy of an alpha-only logo in the theme colour: LVGL can't zoom alpha-only images.
    uint8_t *tintPixels = nullptr;
    size_t tintBytes = 0;
    lv_img_dsc_t tintDsc = {};
    uint32_t tintSource = UINT32_MAX;
    uint32_t tintColor = 0;

    int shownMinute = -1;
    int shownTemp = INT32_MIN;
    unsigned long lastTick = 0;
};

#endif // STANDBYCUSTOMIZER_H
