/**
 * Sitzungszustand im Browser (nur zur Benutzerführung – keine Sicherheitsentscheidungen).
 * me: Profil inkl. Permissions, nav: serverseitig berechnete Navigation, flags: Feature Flags.
 */
export const state = { me: null, nav: null, flags: [] };

/** Hat der Benutzer die Permission irgendwo? Nur für das Ein-/Ausblenden von Bedienelementen. */
export const can = (code) => Boolean(state.me?.permissions?.includes(code));

export const flag = (code) => state.flags.find((f) => f.code === code);
