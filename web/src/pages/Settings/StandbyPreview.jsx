import { useEffect, useState } from 'preact/hooks';
import { useLingui } from '@lingui/react/macro';
import { machine } from '../../services/ApiService.js';
import logoUrl from '../../assets/standby/logo.png';
import wifiUrl from '../../assets/standby/wifi.png';
import bluetoothUrl from '../../assets/standby/bluetooth.png';
import tapUrl from '../../assets/standby/tap.png';
import fontUrl from '../../assets/standby/montserrat-medium-standby.woff2';

// A replica of the display's standby screen, drawn in the panel's own 480x480 coordinates with the artwork and font
// the firmware uses (scripts/export_standby_preview_assets.py). Positions mirror the EEZ standby screen and
// src/display/ui/default/StandbyCustomizer.cpp; keep them in sync when either changes.
const C = 240; // panel centre
const THEMES = [
  { fg: '#fafafa', bg: '#131313' }, // Dark (theme_colors[0])
  { fg: '#131313', bg: '#fafafa' }, // Light (theme_colors[1])
];
const STOCK_LOGO = { w: 392, h: 53 };
// Box a logo is fitted into (never enlarged) per clock style, as in StandbyCustomizer.cpp (LOGO_BOX_*).
const LOGO_BOXES = [
  { w: 392, h: 160, y: 0 }, // digital
  { w: 196, h: 60, y: -130 }, // large
  { w: 200, h: 50, y: -100 }, // analog
  { w: 392, h: 160, y: 0 }, // hidden
];
const FONT = 'GaggiMateStandby';
const DIAL_RADIUS = 236; // full-face meter: 472px, no padding

// An alpha-only firmware image, tinted like LVGL's img_recolor does on the device.
function Tinted({ id, href, cx, cy, w, h, color }) {
  const x = cx - w / 2;
  const y = cy - h / 2;
  return (
    <>
      <mask id={id} maskUnits='userSpaceOnUse' x={x} y={y} width={w} height={h}>
        <image href={href} x={x} y={y} width={w} height={h} preserveAspectRatio='none' />
      </mask>
      <rect x={x} y={y} width={w} height={h} fill={color} mask={`url(#${id})`} />
    </>
  );
}

function Label({ y, size, color, children }) {
  return (
    <text
      x={C}
      y={y}
      fill={color}
      fontFamily={`${FONT}, Montserrat, sans-serif`}
      fontSize={size}
      fontWeight={500}
      textAnchor='middle'
      dominantBaseline='central'
    >
      {children}
    </text>
  );
}

function polar(radius, degrees) {
  const a = (degrees * Math.PI) / 180;
  return [C + radius * Math.cos(a), C + radius * Math.sin(a)];
}

// lv_meter with 61 ticks (every 5th major) and two line needles; LVGL angle 270 is 12 o'clock.
function AnalogDial({ clock, color }) {
  const ticks = [];
  for (let i = 0; i < 61; i++) {
    // Minute ticks, hour markers every fifth, bolder quarter markers (the firmware's second scale).
    const [length, width] = i % 15 === 0 ? [26, 7] : i % 5 === 0 ? [18, 4] : [8, 2];
    const angle = 270 + i * 6;
    const [x1, y1] = polar(DIAL_RADIUS, angle);
    const [x2, y2] = polar(DIAL_RADIUS - length, angle);
    ticks.push(<line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={width} />);
  }
  const hourValue = (clock.hours % 12) * 5 + Math.floor(clock.minutes / 12);
  const [hx, hy] = polar(DIAL_RADIUS - 100, 270 + hourValue * 6);
  const [mx, my] = polar(DIAL_RADIUS - 28, 270 + clock.minutes * 6);
  return (
    <g>
      {ticks}
      <line x1={C} y1={C} x2={hx} y2={hy} stroke={color} strokeWidth={10} strokeLinecap='round' />
      <line x1={C} y1={C} x2={mx} y2={my} stroke={color} strokeWidth={6} strokeLinecap='round' />
      <circle cx={C} cy={C} r={9} fill={color} />
    </g>
  );
}

// The display shows its own timezone setting (an IANA name), not the browser's; fall back to local time if unknown.
function deviceClock(now, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone || undefined,
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(now);
    const get = type => Number(parts.find(p => p.type === type)?.value);
    return { hours: get('hour') % 24, minutes: get('minute') };
  } catch {
    return { hours: now.getHours(), minutes: now.getMinutes() };
  }
}

function formatTime(clock, is24h) {
  const minutes = String(clock.minutes).padStart(2, '0');
  if (is24h) return { time: `${String(clock.hours).padStart(2, '0')}:${minutes}`, ampm: '' };
  return { time: `${clock.hours % 12 || 12}:${minutes}`, ampm: clock.hours < 12 ? 'AM' : 'PM' };
}

export function StandbyPreview({ formData, image, logo: customLogo }) {
  const { t } = useLingui();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(timer);
  }, []);

  const theme = THEMES[Number(formData.themeMode) === 1 ? 1 : 0];
  const style = Number(formData.standbyClockStyle ?? 0);
  const showLogo = formData.standbyShowLogo ?? true;
  const showTemp = !!formData.standbyShowTemp;
  const dim = Number(formData.standbyImageDim ?? 35) / 100;
  const is24h = formData.clock24hFormat ?? true;
  const clock = deviceClock(now, formData.timezone);
  const { time, ampm } = formatTime(clock, is24h);
  const currentTemp = machine.value.status?.currentTemperature;
  const temp = `${Math.round(currentTemp > 0 ? currentTemp : 93)}°C`;

  // Logo fit and temperature placement per clock style, with the firmware's integer zoom (1/256 steps).
  const source = customLogo ?? STOCK_LOGO;
  const box = LOGO_BOXES[style] ?? LOGO_BOXES[0];
  const zoom = Math.max(
    1,
    Math.min(256, Math.floor((box.w * 256) / source.w), Math.floor((box.h * 256) / source.h)),
  );
  const logo = {
    cy: C + box.y,
    w: Math.floor((source.w * zoom) / 256),
    h: Math.floor((source.h * zoom) / 256),
  };
  let tempY = C + 62;
  if (style === 1) tempY = C + 98;
  else if (style === 2) tempY = C + 100;
  else if (customLogo && showLogo) tempY = C + Math.max(62, Math.floor(logo.h / 2) + 30);

  return (
    <svg
      viewBox='0 0 480 480'
      className='h-full w-full'
      role='img'
      aria-label={t`Preview of the standby screen`}
    >
      <style>{`@font-face { font-family: ${FONT}; src: url(${fontUrl}) format('woff2'); font-weight: 500; }`}</style>
      <defs>
        <clipPath id='sbp-panel'>
          <circle cx={C} cy={C} r={C} />
        </clipPath>
      </defs>
      <g clipPath='url(#sbp-panel)'>
        <rect width='480' height='480' fill={theme.bg} />
        {image && (
          <>
            <image href={image} width='480' height='480' preserveAspectRatio='xMidYMid slice' />
            <rect width='480' height='480' fill={theme.bg} opacity={dim} />
          </>
        )}

        {/* Status icons (Wi-Fi, Bluetooth), the tap hint and the logo, as on the stock screen. */}
        <Tinted id='sbp-wifi' href={wifiUrl} cx={215} cy={30} w={20} h={20} color={theme.fg} />
        <Tinted id='sbp-bt' href={bluetoothUrl} cx={265} cy={30} w={20} h={20} color={theme.fg} />
        <Tinted id='sbp-tap' href={tapUrl} cx={C} cy={C + 150} w={48} h={48} color={theme.fg} />

        {showLogo &&
          (customLogo && !customLogo.tint ? (
            <image
              href={customLogo.preview}
              x={C - logo.w / 2}
              y={logo.cy - logo.h / 2}
              width={logo.w}
              height={logo.h}
              preserveAspectRatio='none'
            />
          ) : (
            <Tinted
              id='sbp-logo'
              href={customLogo ? customLogo.preview : logoUrl}
              cx={C}
              cy={logo.cy}
              w={logo.w}
              h={logo.h}
              color={theme.fg}
            />
          ))}

        {style === 0 && (
          <Label y={C - 150} size={34} color={theme.fg}>
            {is24h ? time : `${time} ${ampm}`}
          </Label>
        )}
        {style === 1 && (
          <>
            <Label y={C - 10} size={110} color={theme.fg}>
              {time}
            </Label>
            {ampm && (
              <Label y={C + 62} size={24} color={theme.fg}>
                {ampm}
              </Label>
            )}
          </>
        )}
        {showTemp && (
          <Label y={tempY} size={24} color={theme.fg}>
            {temp}
          </Label>
        )}
        {/* Hands on top, as on the device. */}
        {style === 2 && <AnalogDial clock={clock} color={theme.fg} />}
      </g>
    </svg>
  );
}
