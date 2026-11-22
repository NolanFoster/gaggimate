#ifndef STANDBYIMAGE_H
#define STANDBYIMAGE_H

#include <Arduino.h>

// Standby background image on LittleFS: a 4-byte LVGL image header + 480x480 RGB565 (little endian), converted in the
// web UI. Same layout as profile images (ProfileImage.h), sized for the full panel.
namespace standby_image {

constexpr uint32_t SIZE = 480;
constexpr uint32_t COLOR_FORMAT = 4; // LV_IMG_CF_TRUE_COLOR
constexpr uint32_t HEADER = COLOR_FORMAT | (SIZE << 10) | (SIZE << 21);
constexpr size_t HEADER_BYTES = 4;
constexpr size_t PIXEL_BYTES = SIZE * SIZE * 2;
constexpr size_t FILE_BYTES = HEADER_BYTES + PIXEL_BYTES;
constexpr const char *PATH = "/standby.bin";
constexpr const char *TEMP_PATH = "/standby.tmp";
// Free space that must remain on LittleFS after an upload, so profiles and shot history keep room to grow.
constexpr size_t RESERVE_BYTES = 256 * 1024;

} // namespace standby_image

// Custom standby logo on LittleFS: a 4-byte LVGL image header + pixels, trimmed and scaled in the web UI.
// Either alpha-only (tinted with the theme colour, like the stock logo) or RGB565 + alpha (kept as uploaded).
namespace standby_logo {

constexpr uint32_t MAX_W = 400;
constexpr uint32_t MAX_H = 160;
constexpr uint32_t CF_TRUE_COLOR_ALPHA = 5; // LV_IMG_CF_TRUE_COLOR_ALPHA: RGB565 little endian + alpha byte
constexpr uint32_t CF_ALPHA_8BIT = 14;      // LV_IMG_CF_ALPHA_8BIT
constexpr size_t HEADER_BYTES = 4;
constexpr const char *PATH = "/standby_logo.bin";
constexpr const char *TEMP_PATH = "/standby_logo.tmp";

struct Header {
    uint32_t cf = 0;
    uint32_t w = 0;
    uint32_t h = 0;
};

inline size_t bytesPerPixel(uint32_t cf) { return cf == CF_ALPHA_8BIT ? 1 : 3; }

// Validates an LVGL header (cf:5 always_zero:3 reserved:2 w:11 h:11) and that the file size matches it.
inline bool parseHeader(uint32_t raw, size_t fileBytes, Header &out) {
    out.cf = raw & 0x1F;
    out.w = (raw >> 10) & 0x7FF;
    out.h = (raw >> 21) & 0x7FF;
    if ((raw >> 5) & 0x7) // always_zero
        return false;
    if (out.cf != CF_ALPHA_8BIT && out.cf != CF_TRUE_COLOR_ALPHA)
        return false;
    if (out.w == 0 || out.h == 0 || out.w > MAX_W || out.h > MAX_H)
        return false;
    return fileBytes == HEADER_BYTES + static_cast<size_t>(out.w) * out.h * bytesPerPixel(out.cf);
}

} // namespace standby_logo

#endif // STANDBYIMAGE_H
