// Line icons on a 24px grid, drawn with the current text color.
const PATHS = {
  hash: '<path d="M5 9h14M5 15h14M10.5 4 9 20M15 4l-1.5 16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>',
  close: '<path d="M17.5 6.5l-11 11M6.5 6.5l11 11"/>',
  back: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
  reply: '<path d="M20 15.5a2 2 0 0 1-2 2H8l-4 3.5V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2Z"/>',
  smile: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 14a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/>',
  more: '<path d="M5.5 12h.01M12 12h.01M18.5 12h.01"/>',
  sun: '<circle cx="12" cy="12" r="3.75"/><path d="M12 2.75v2M12 19.25v2M4.75 12h-2M21.25 12h-2M6.9 6.9 5.5 5.5M18.5 18.5l-1.4-1.4M6.9 17.1l-1.4 1.4M18.5 5.5l-1.4 1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>',
  auto: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17Z" fill="currentColor" stroke="none"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  pencil: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4ZM13.5 6.5l4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 12a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2l1-12M9 7V4.5h6V7"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
  spark: '<path d="M12 3.5c.5 4.4 3.6 7.5 8 8-4.4.5-7.5 3.6-8 8-.5-4.4-3.6-7.5-8-8 4.4-.5 7.5-3.6 8-8Z"/>',
  tasks: '<path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
  file: '<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5ZM14 3.5v5h5"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
};

export const icon = (name, size = 16) =>
  `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;
