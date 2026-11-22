import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { Trans, useLingui } from '@lingui/react/macro';
import { SettingsFormField, ToggleField } from '../../components/SettingsFormField.jsx';
import { ACCEPTED_IMAGE_TYPES, isGif } from '../../utils/profileImage.js';
import { StandbyPreview } from './StandbyPreview.jsx';
import {
  LOGO_IMAGE_TYPES,
  deleteStandbyImage,
  deleteStandbyLogo,
  fetchStandbyImagePreview,
  fetchStandbyLogo,
  uploadStandbyImage,
  uploadStandbyLogo,
} from '../../utils/standbyImage.js';

// Firmware defaults: the stock standby screen.
const STANDBY_DEFAULTS = {
  standbyClockStyle: 0,
  standbyShowLogo: true,
  standbyShowTemp: false,
  standbyImageDim: 35,
};

// Layout options save with the form; the background image uploads (and is removed) immediately, like profile images.
export function StandbyScreenSettings({ formData, onChange, updateFormFields }) {
  const { t } = useLingui();
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);
  const rev = formData.standbyImageRev;
  // Custom logo: { preview, w, h, tint } as stored on the display, or null for the stock logo.
  const [logo, setLogo] = useState(null);
  const [logoTint, setLogoTint] = useState(true);
  const [logoFile, setLogoFile] = useState(null); // last picked file, to re-convert when the tint toggle flips
  const logoInputRef = useRef(null);
  const logoRev = formData.standbyLogoRev;

  useEffect(() => {
    let cancelled = false;
    fetchStandbyLogo(logoRev)
      .then(stored => {
        if (cancelled) return;
        setLogo(stored);
        if (stored) setLogoTint(stored.tint);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [logoRev]);

  useEffect(() => {
    let cancelled = false;
    fetchStandbyImagePreview(rev)
      .then(url => {
        if (!cancelled) setPreview(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [rev]);

  const onFile = useCallback(
    async e => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      setError('');
      if (await isGif(file, file.name)) {
        setError(t`GIF images are not supported. Please use PNG, JPEG, WebP or BMP.`);
        return;
      }
      if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
        setError(t`Unsupported file type. Please use PNG, JPEG, WebP or BMP.`);
        return;
      }
      setBusy(true);
      try {
        setPreview(await uploadStandbyImage(file));
      } catch (err) {
        setError(err.message || t`Could not read this image.`);
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  const onRemove = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      await deleteStandbyImage();
      setPreview(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, []);

  const sendLogo = useCallback(
    async (file, tint) => {
      setBusy(true);
      setError('');
      try {
        setLogo(await uploadStandbyLogo(file, tint));
      } catch (err) {
        setError(err.message || t`Could not read this image.`);
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  const onLogoFile = useCallback(
    async e => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      if ((await isGif(file, file.name)) || !LOGO_IMAGE_TYPES.includes(file.type)) {
        setError(t`Unsupported file type. Please use PNG, SVG, JPEG, WebP or BMP.`);
        return;
      }
      setLogoFile(file);
      await sendLogo(file, logoTint);
    },
    [logoTint, sendLogo, t],
  );

  // Re-converts the logo in the other mode: from the picked file if there is one, else from the stored copy.
  const onLogoTintToggle = useCallback(async () => {
    const tint = !logoTint;
    setLogoTint(tint);
    const source = logoFile ?? (logo ? await (await fetch(logo.preview)).blob() : null);
    if (source) await sendLogo(source, tint);
  }, [logo, logoFile, logoTint, sendLogo]);

  const onLogoRemove = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      await deleteStandbyLogo();
      setLogo(null);
      setLogoFile(null);
      setLogoTint(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, []);

  // Applies at once (no Save needed), so the display is back to stock even if the form is left unsaved.
  const onRestore = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      await deleteStandbyImage();
      setPreview(null);
      await deleteStandbyLogo();
      setLogo(null);
      setLogoFile(null);
      setLogoTint(true);
      const body = new FormData();
      body.set('standbyClockStyle', String(STANDBY_DEFAULTS.standbyClockStyle));
      body.set('standbyShowLogo', STANDBY_DEFAULTS.standbyShowLogo ? '1' : '0');
      body.set('standbyShowTemp', STANDBY_DEFAULTS.standbyShowTemp ? '1' : '0');
      body.set('standbyImageDim', String(STANDBY_DEFAULTS.standbyImageDim));
      const response = await fetch('/api/settings', { method: 'POST', body });
      if (!response.ok) throw new Error(t`Could not restore the default standby screen.`);
      updateFormFields(STANDBY_DEFAULTS);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [t, updateFormFields]);

  return (
    <div className='border-base-content/5 mt-6 border-t pt-6'>
      <h3 className='mb-4 text-sm font-semibold'>
        <Trans>Standby Screen</Trans>
      </h3>
      <div className='flex flex-col gap-4 sm:flex-row sm:items-start'>
        <figure className='flex shrink-0 flex-col items-center gap-1 self-center sm:self-start'>
          <div className='ring-base-content/10 h-48 w-48 overflow-hidden rounded-full shadow-md ring-1'>
            <StandbyPreview formData={formData} image={preview} logo={logo} />
          </div>
          <figcaption className='text-center text-xs opacity-60'>
            <Trans>Live preview · Save to apply</Trans>
          </figcaption>
        </figure>
        <div className='flex min-w-0 flex-1 flex-col gap-2'>
          <div className='flex flex-row flex-wrap gap-2'>
            <input
              ref={inputRef}
              id='standby-image'
              type='file'
              accept={ACCEPTED_IMAGE_TYPES.join(',')}
              className='hidden'
              onChange={onFile}
            />
            <button
              type='button'
              className='btn btn-sm'
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              {preview ? t`Replace background` : t`Upload background`}
            </button>
            {preview && (
              <button
                type='button'
                className='btn btn-sm btn-ghost'
                disabled={busy}
                onClick={onRemove}
              >
                <Trans>Remove</Trans>
              </button>
            )}
          </div>
          <p className='text-xs opacity-70'>
            <Trans>
              PNG, JPEG, WebP or BMP. The image is cropped to a square, scaled to 480×480 pixels and
              stored on the display. It changes right away.
            </Trans>
          </p>
          {error && <p className='text-error text-xs'>{error}</p>}
          {preview && (
            <SettingsFormField
              label={t`Background dimming: ${formData.standbyImageDim ?? STANDBY_DEFAULTS.standbyImageDim}%`}
              htmlFor='standbyImageDim'
              helpText={t`Darkens the image (or lightens it in the light theme) so the clock stays readable.`}
              noMargin
            >
              <input
                id='standbyImageDim'
                name='standbyImageDim'
                type='range'
                className='range range-sm w-full'
                min={0}
                max={80}
                step={5}
                value={formData.standbyImageDim ?? STANDBY_DEFAULTS.standbyImageDim}
                onChange={onChange('standbyImageDim')}
              />
            </SettingsFormField>
          )}
        </div>
      </div>

      <div className='mt-4 grid grid-cols-1 gap-4 md:grid-cols-2'>
        <SettingsFormField label={t`Clock`} htmlFor='standbyClockStyle' noMargin>
          <select
            id='standbyClockStyle'
            name='standbyClockStyle'
            className='select select-bordered w-full'
            value={String(formData.standbyClockStyle ?? 0)}
            onChange={onChange('standbyClockStyle')}
          >
            {/* String values, so live re-renders don't rewrite the options (see GeneralTab themeMode). */}
            <option value='0'>{t`Digital (default)`}</option>
            <option value='1'>{t`Large digital`}</option>
            <option value='2'>{t`Analog`}</option>
            <option value='3'>{t`Hidden`}</option>
          </select>
        </SettingsFormField>
        <div className='flex flex-col justify-end gap-2'>
          <ToggleField
            label={t`Show logo`}
            htmlFor='standbyShowLogo'
            checked={formData.standbyShowLogo ?? true}
            onChange={onChange('standbyShowLogo')}
          />
          <ToggleField
            label={t`Show boiler temperature`}
            htmlFor='standbyShowTemp'
            checked={!!formData.standbyShowTemp}
            onChange={onChange('standbyShowTemp')}
          />
        </div>
      </div>

      <div className='mt-6 flex flex-col gap-2'>
        <span className='text-sm font-medium'>
          <Trans>Logo</Trans>
        </span>
        <div className='flex flex-row flex-wrap items-center gap-2'>
          <div className='bg-neutral flex h-12 w-32 shrink-0 items-center justify-center rounded px-2'>
            {logo ? (
              <img src={logo.preview} alt={t`Custom logo`} className='max-h-10 max-w-full' />
            ) : (
              <span className='text-neutral-content text-xs opacity-70'>
                <Trans>GaggiMate (default)</Trans>
              </span>
            )}
          </div>
          <input
            ref={logoInputRef}
            id='standby-logo'
            type='file'
            accept={LOGO_IMAGE_TYPES.join(',')}
            className='hidden'
            onChange={onLogoFile}
          />
          <button
            type='button'
            className='btn btn-sm'
            disabled={busy}
            onClick={() => logoInputRef.current?.click()}
          >
            {logo ? t`Replace logo` : t`Upload logo`}
          </button>
          {logo && (
            <button
              type='button'
              className='btn btn-sm btn-ghost'
              disabled={busy}
              onClick={onLogoRemove}
            >
              <Trans>Use default logo</Trans>
            </button>
          )}
        </div>
        <ToggleField
          label={t`Tint to theme colour`}
          htmlFor='standbyLogoTint'
          checked={logoTint}
          onChange={onLogoTintToggle}
        />
        <p className='text-xs opacity-70'>
          <Trans>
            PNG or SVG with a transparent background works best; a plain background is removed
            automatically. Empty edges are trimmed and the logo is fitted into 400×160 pixels.
            Tinted logos are drawn in the theme's text colour like the stock logo; turn it off to
            keep the logo's own colours (re-upload the file to get them back after tinting).
          </Trans>
        </p>
      </div>

      <button
        type='button'
        className='btn btn-sm btn-ghost mt-4'
        disabled={busy}
        onClick={onRestore}
      >
        <Trans>Restore default standby screen</Trans>
      </button>
    </div>
  );
}
