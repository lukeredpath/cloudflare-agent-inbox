export type Theme = "system" | "light" | "dark";
const KEY = "aib-theme";

export function loadTheme(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // storage can be unavailable; the system setting is a fine default
  }
  return "system";
}

/** One attribute on the root: absent follows the system setting. */
export function applyTheme(theme: Theme): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // not remembered; still applied for this visit
  }
}
