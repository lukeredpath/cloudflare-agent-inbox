const PATHS = {
  home: "M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 22V12h6v10",
  mail: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6",
  agent: "M9 9h6v6H9zM4 4h16v16H4zM9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3",
  ban: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM4.93 4.93l14.14 14.14",
  lane: "M3 6h18M3 12h18M3 18h12",
  copy: "M9 9h11v11H9zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
  eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  eyeoff:
    "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M1 1l22 22",
  pause: "M6 4h4v16H6zM14 4h4v16h-4z",
  play: "M6 3l14 9-14 9V3z",
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6",
  rotate: "M23 4v6h-6M20.49 15a9 9 0 1 1-2.12-9.36L23 10",
  plus: "M12 5v14M5 12h14",
  x: "M18 6 6 18M6 6l12 12",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.35-4.35",
  alert:
    "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01",
  info: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 16v-4M12 8h.01",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  key: "M15.5 7.5 19 4l2 2-3.5 3.5M15.5 7.5l2 2M11.4 11.6a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0 4.1-4.1",
  edit: "M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z",
  lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
  zip: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M10 6h1M10 9h1M10 12h1M10 15h1v3h-1z",
  menu: "M3 6h18M3 12h18M3 18h18",
} as const;

export type IconName = keyof typeof PATHS;

/** Decorative: every use sits next to text, so it is hidden from assistive technology. */
export function Icon({ name }: { name: IconName }) {
  return (
    <svg class="i" viewBox="0 0 24 24" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
