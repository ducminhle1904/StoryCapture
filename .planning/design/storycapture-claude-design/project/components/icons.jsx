/* global React */
// Lucide-style icons — minimal, stroked, 1.6 width
const Icon = ({ children, size = 16, stroke = 1.6, className = "", style = {} }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round"
    className={className} style={style} aria-hidden="true">
    {children}
  </svg>
);

const I = {
  Film:     (p) => <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/></Icon>,
  Home:     (p) => <Icon {...p}><path d="M4 11l8-7 8 7"/><path d="M6 10v10h12V10"/></Icon>,
  Grid:     (p) => <Icon {...p}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></Icon>,
  Code:     (p) => <Icon {...p}><path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/></Icon>,
  Scissors: (p) => <Icon {...p}><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12"/></Icon>,
  Download: (p) => <Icon {...p}><path d="M12 3v12M7 10l5 5 5-5M4 21h16"/></Icon>,
  Settings: (p) => <Icon {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></Icon>,
  Plus:     (p) => <Icon {...p}><path d="M12 5v14M5 12h14"/></Icon>,
  Search:   (p) => <Icon {...p}><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></Icon>,
  Play:     (p) => <Icon {...p}><path d="M6 4l14 8-14 8V4z" fill="currentColor"/></Icon>,
  PlayOutline: (p) => <Icon {...p}><path d="M6 4l14 8-14 8V4z"/></Icon>,
  Pause:    (p) => <Icon {...p}><rect x="6" y="4" width="4" height="16" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4" height="16" fill="currentColor" stroke="none"/></Icon>,
  Record:   (p) => <Icon {...p}><circle cx="12" cy="12" r="8" fill="currentColor" stroke="none"/></Icon>,
  Stop:     (p) => <Icon {...p}><rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none"/></Icon>,
  SkipBack: (p) => <Icon {...p}><polygon points="19 20 9 12 19 4 19 20" fill="currentColor" stroke="none"/><line x1="5" y1="19" x2="5" y2="5"/></Icon>,
  SkipForward: (p) => <Icon {...p}><polygon points="5 4 15 12 5 20 5 4" fill="currentColor" stroke="none"/><line x1="19" y1="5" x2="19" y2="19"/></Icon>,
  Mic:      (p) => <Icon {...p}><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M19 11a7 7 0 01-14 0M12 18v3"/></Icon>,
  Camera:   (p) => <Icon {...p}><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></Icon>,
  Monitor:  (p) => <Icon {...p}><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></Icon>,
  Globe:    (p) => <Icon {...p}><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/></Icon>,
  ZoomIn:   (p) => <Icon {...p}><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6M11 8v6"/></Icon>,
  Volume:   (p) => <Icon {...p}><path d="M11 5L6 9H2v6h4l5 4V5zM15 9a5 5 0 010 6M19 7a9 9 0 010 10"/></Icon>,
  MousePointer: (p) => <Icon {...p}><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></Icon>,
  Sparkles: (p) => <Icon {...p}><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3zM19 15l.8 2.4L22 18l-2.2.6L19 21l-.8-2.4L16 18l2.2-.6L19 15z"/></Icon>,
  Wand:     (p) => <Icon {...p}><path d="M15 4V2M15 10V8M19 6h2M11 6h2M17 4L19 2M17 8L19 10M5 21l15-15-3-3L2 18z"/></Icon>,
  ChevronDown: (p) => <Icon {...p}><path d="M6 9l6 6 6-6"/></Icon>,
  ChevronRight:(p) => <Icon {...p}><path d="M9 6l6 6-6 6"/></Icon>,
  ChevronUp:(p) => <Icon {...p}><path d="M18 15l-6-6-6 6"/></Icon>,
  Command:  (p) => <Icon {...p}><path d="M18 3a3 3 0 00-3 3v12a3 3 0 003 3 3 3 0 003-3 3 3 0 00-3-3H6a3 3 0 00-3 3 3 3 0 003 3 3 3 0 003-3V6a3 3 0 00-3-3 3 3 0 00-3 3 3 3 0 003 3h12a3 3 0 003-3 3 3 0 00-3-3z"/></Icon>,
  Clock:    (p) => <Icon {...p}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></Icon>,
  File:     (p) => <Icon {...p}><path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M14 3v6h6"/></Icon>,
  FolderOpen:(p) => <Icon {...p}><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v2H3z"/><path d="M3 11l2 8h14l2-8"/></Icon>,
  Trash:    (p) => <Icon {...p}><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></Icon>,
  Copy:     (p) => <Icon {...p}><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></Icon>,
  Check:    (p) => <Icon {...p}><path d="M4 12l5 5L20 6"/></Icon>,
  X:        (p) => <Icon {...p}><path d="M18 6L6 18M6 6l12 12"/></Icon>,
  AlertCircle: (p) => <Icon {...p}><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></Icon>,
  Info:     (p) => <Icon {...p}><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></Icon>,
  Eye:      (p) => <Icon {...p}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></Icon>,
  EyeOff:   (p) => <Icon {...p}><path d="M17.94 17.94A10 10 0 0112 20c-7 0-11-8-11-8a19.5 19.5 0 015.06-6M9.9 5.24A9 9 0 0112 5c7 0 11 7 11 7a20 20 0 01-3.17 4.3M1 1l22 22M14.12 14.12a3 3 0 01-4.24-4.24"/></Icon>,
  Sun:      (p) => <Icon {...p}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></Icon>,
  Moon:     (p) => <Icon {...p}><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></Icon>,
  Keyboard: (p) => <Icon {...p}><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h12"/></Icon>,
  Key:      (p) => <Icon {...p}><circle cx="8" cy="15" r="4"/><path d="M10.85 12.15L21 2l-3 3M17 8l3-3"/></Icon>,
  Bell:     (p) => <Icon {...p}><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0"/></Icon>,
  Filter:   (p) => <Icon {...p}><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/></Icon>,
  Layers:   (p) => <Icon {...p}><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></Icon>,
  Maximize: (p) => <Icon {...p}><path d="M4 8V5a1 1 0 011-1h3M20 8V5a1 1 0 00-1-1h-3M4 16v3a1 1 0 001 1h3M20 16v3a1 1 0 01-1 1h-3"/></Icon>,
  Zap:      (p) => <Icon {...p}><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></Icon>,
  User:     (p) => <Icon {...p}><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a7 7 0 0116 0v1"/></Icon>,
  Lock:     (p) => <Icon {...p}><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></Icon>,
  MoreH:    (p) => <Icon {...p}><circle cx="6" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.5" fill="currentColor" stroke="none"/></Icon>,
  Arrow:    (p) => <Icon {...p}><path d="M5 12h14M13 6l6 6-6 6"/></Icon>,
  Circle:   (p) => <Icon {...p}><circle cx="12" cy="12" r="9"/></Icon>,
  Square:   (p) => <Icon {...p}><rect x="3" y="3" width="18" height="18" rx="2"/></Icon>,
};

window.I = I;
window.Icon = Icon;
