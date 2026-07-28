import type { SVGProps } from 'react'

export type IconName =
  | 'workflow' | 'image' | 'queue' | 'pulse' | 'plug' | 'settings' | 'search'
  | 'play' | 'stop' | 'save' | 'command' | 'grid' | 'list' | 'chevron'
  | 'chevron-up' | 'chevron-down' | 'chevron-left' | 'chevron-right'
  | 'plus' | 'layers' | 'clock' | 'check' | 'warning' | 'error' | 'star'
  | 'more' | 'filter' | 'download' | 'compare' | 'brush' | 'matrix' | 'pin'
  | 'mock' | 'bypass' | 'collapse' | 'close' | 'folder' | 'board' | 'spark'
  | 'lock' | 'key' | 'server' | 'shield' | 'info' | 'eye' | 'trash'
  | 'copy' | 'undo' | 'redo' | 'fit' | 'minimap' | 'note' | 'frame'
  | 'terminal' | 'external' | 'edit' | 'tag' | 'calendar' | 'code'
  | 'align-left' | 'align-top' | 'distribute-horizontal' | 'distribute-vertical'
  | 'align-right' | 'align-bottom' | 'align-center-horizontal' | 'align-center-vertical'
  | 'marquee' | 'paste' | 'link'

const paths: Record<IconName, readonly string[]> = {
  workflow: ['M4 5h5v5H4zM15 14h5v5h-5zM15 4h5v5h-5z', 'M9 7.5h3a3 3 0 0 1 3 3v3.5M12 16.5H9'],
  image: ['M4 5h16v14H4z', 'm4 15 4-4 3 3 3-3 6 6', 'M15.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z'],
  queue: ['M6 6h14M6 12h14M6 18h14', 'M3 6h.01M3 12h.01M3 18h.01'],
  pulse: ['M3 13h4l2-7 4 12 2-7 2 2h4'],
  plug: ['M8 3v5M16 3v5', 'M6 8h12v2a6 6 0 0 1-12 0z', 'M12 16v5'],
  settings: ['M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z', 'M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2 3.46-.08-.02a1.7 1.7 0 0 0-1.8.35l-.53.3a1.7 1.7 0 0 0-.85 1.7V22h-4v-.08a1.7 1.7 0 0 0-.86-1.7l-.52-.3a1.7 1.7 0 0 0-1.81-.35h-.08l-2-3.45.06-.06A1.7 1.7 0 0 0 5 15.18v-.6a1.7 1.7 0 0 0-1.2-1.54l-.08-.03V9l.08-.03A1.7 1.7 0 0 0 5 7.42v-.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2-3.46.08.02a1.7 1.7 0 0 0 1.8-.35l.53-.3A1.7 1.7 0 0 0 9.86-.9V-1h4v.08a1.7 1.7 0 0 0 .86 1.7l.52.3a1.7 1.7 0 0 0 1.81.35h.08l2 3.45-.06.06a1.7 1.7 0 0 0-.34 1.88v.6a1.7 1.7 0 0 0 1.2 1.54l.08.03v4l-.08.03a1.7 1.7 0 0 0-1.2 1.55z'],
  search: ['m21 21-4.4-4.4', 'M10.8 18a7.2 7.2 0 1 0 0-14.4 7.2 7.2 0 0 0 0 14.4Z'],
  play: ['m8 5 11 7-11 7z'], stop: ['M7 7h10v10H7z'], save: ['M5 4h12l2 2v14H5z', 'M8 4v6h8V4M8 20v-6h8v6'],
  command: ['M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z'],
  grid: ['M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z'], list: ['M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01'],
  chevron: ['m9 6 6 6-6 6'],
  'chevron-up': ['m6 15 6-6 6 6'],
  'chevron-down': ['m6 9 6 6 6-6'],
  'chevron-left': ['m15 6-6 6 6 6'],
  'chevron-right': ['m9 6 6 6-6 6'],
  plus: ['M12 5v14M5 12h14'], layers: ['m12 3 9 5-9 5-9-5z', 'm3 12 9 5 9-5M3 16l9 5 9-5'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7v5l3 2'],
  check: ['m5 12 4 4L19 6'], warning: ['M12 3 22 20H2z', 'M12 9v4M12 17h.01'], error: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'm9 9 6 6m0-6-6 6'],
  star: ['m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2-4.5-4.4 6.2-.9z'], more: ['M5 12h.01M12 12h.01M19 12h.01'],
  filter: ['M4 5h16l-6 7v5l-4 2v-7z'], download: ['M12 4v11m-4-4 4 4 4-4', 'M5 20h14'],
  compare: ['M4 4h16v16H4z', 'M12 4v16', 'm8 12-2-2m2 2-2 2m8-2 2-2m-2 2 2 2'],
  brush: ['m14 4 6 6-8.5 8.5c-1.7 1.7-4.3 1.8-6.1.2 1.7-.2 2.2-1.2 2-2.8-.2-1.4.5-2.8 1.6-3.7z'],
  matrix: ['M4 4h16v16H4zM4 10h16M10 4v16M15 4v16M4 15h16'],
  pin: ['m8 4 8 8m-6-6 6-2 4 4-2 6-4-4-6 6', 'm9 15-5 5'], mock: ['M5 4h14v16H5z', 'm8 9 2 2-2 2m8-4-2 2 2 2'],
  bypass: ['M4 12h16M15 7l5 5-5 5'], collapse: ['m7 10 5-5 5 5M7 14l5 5 5-5'], close: ['m6 6 12 12m0-12L6 18'],
  folder: ['M3 6h7l2 2h9v11H3z'], board: ['M4 4h16v16H4zM9 4v16M9 10h11'], spark: ['m12 3 1.4 5.6L19 10l-5.6 1.4L12 17l-1.4-5.6L5 10l5.6-1.4z'],
  lock: ['M6 10h12v10H6z', 'M8 10V7a4 4 0 0 1 8 0v3'], key: ['M15 8a5 5 0 1 1-4.6 7H3v-3h3v-2h4.4A5 5 0 0 1 15 8Z'],
  server: ['M4 4h16v6H4zM4 14h16v6H4z', 'M8 7h.01M8 17h.01M12 7h5M12 17h5'], shield: ['M12 3 20 6v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6z', 'm9 12 2 2 4-5'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 11v6M12 7h.01'], eye: ['M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6S2.5 12 2.5 12Z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'],
  trash: ['M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13'], copy: ['M8 8h11v12H8zM5 16H4V4h11v1'],
  undo: ['m9 7-5 5 5 5', 'M4 12h9a6 6 0 0 1 6 6'], redo: ['m15 7 5 5-5 5', 'M20 12h-9a6 6 0 0 0-6 6'],
  fit: ['M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5'], minimap: ['M4 5h16v14H4zM7 9h4v3H7zM14 13h3v3h-3z'],
  note: ['M5 4h14v16H5zM9 8h6M9 12h6M9 16h4'], frame: ['M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5'],
  terminal: ['M4 5h16v14H4z', 'm7 9 3 3-3 3M12 15h5'], external: ['M14 4h6v6M20 4l-9 9', 'M18 13v7H4V6h7'],
  edit: ['m4 20 4-1 11-11-3-3L5 16zM14 6l3 3'], tag: ['M3 12V5h7l11 11-5 5z', 'M7 8h.01'], calendar: ['M4 6h16v14H4zM8 3v6M16 3v6M4 10h16'],
  code: ['m9 18-6-6 6-6m6 0 6 6-6 6'],
  'align-left': ['M5 4v16', 'M9 7h10M9 12h7M9 17h10'],
  'align-top': ['M4 5h16', 'M7 9v10M12 9v7M17 9v10'],
  'align-right': ['M19 4v16', 'M5 7h10M8 12h7M5 17h10'],
  'align-bottom': ['M4 19h16', 'M7 5v10M12 8v7M17 5v10'],
  'align-center-horizontal': ['M12 4v16', 'M6 8h12M8 14h8'],
  'align-center-vertical': ['M4 12h16', 'M8 6v12M14 8v8'],
  'distribute-horizontal': ['M4 5v14M20 5v14', 'M8 8h3v8H8zM14 8h3v8h-3z'],
  'distribute-vertical': ['M5 4h14M5 20h14', 'M8 8h8v3H8zM8 14h8v3H8z'],
  marquee: ['M4 4h3M10 4h4M17 4h3M4 20h3M10 20h4M17 20h3M4 7v3M4 14v3M20 7v3M20 14v3'],
  paste: ['M9 4h6v3H9z', 'M7 6H5v14h14V6h-2', 'M9 12h6M9 16h4'],
  link: ['M9 15 15 9', 'M10.5 6.5 12 5a4 4 0 0 1 6 6l-1.5 1.5M13.5 17.5 12 19a4 4 0 0 1-6-6l1.5-1.5'],
}

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  readonly name: IconName
  readonly size?: number
}

export function Icon({ name, size = 18, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      {...props}
    >
      {paths[name].map((path, index) => <path d={path} key={`${name}-${index}`} />)}
    </svg>
  )
}
