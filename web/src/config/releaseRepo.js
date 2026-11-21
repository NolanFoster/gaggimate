// GitHub repository ("owner/name") that app bundle updates and patch notes come from; it should match
// GAGGIMATE_RELEASE_REPO in the firmware. Override at build time with VITE_RELEASE_REPO=jniebuhr/gaggimate.
export const RELEASE_REPO = import.meta.env.VITE_RELEASE_REPO || 'NolanFoster/gaggimate';
