/**
 * Inline SVG glyphs. `next/image` is not used anywhere in this app (see
 * next.config.ts) — there are only a handful of icons and they need to
 * inherit `currentColor` for theming, which inline SVG gives for free.
 */

interface IconProps {
  readonly size?: number;
  readonly className?: string;
}

export function DropGlyph({ size = 32, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M16 4v16m0 0 6-6m-6 6-6-6"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6 22v3a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CheckIcon({ size = 12, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M2.5 6.25 5 8.75 9.5 3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CloseIcon({ size = 12, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M2.5 2.5l7 7m0-7-7 7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ChevronDownIcon({ size = 10, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M2 3.5 5 6.5 8 3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Rotates to point right when collapsed, down when expanded (caller sets the class). */
export function DisclosureIcon({ size = 10, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M3 2l4 3-4 3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function GearIcon({ size = 15, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      {/*
        A gear is a thick ring whose teeth TOUCH it. The previous version drew a
        thin circle with eight detached spokes, which is the universal shape for
        brightness — misleading in an app whose first setting is the theme.
        The teeth are deliberately chunky: at 15px in `--text-tertiary` grey,
        anything finer anti-aliases away and the icon collapses back into a
        plain ring. Verified by rendering at actual size, not by eyeballing the
        SVG. Ring stroke 2.6 at r=4.3 spans 3.0–5.6, so the centre stays hollow.
      */}
      <path
        d="M11.90 8.00L15.40 8.00M10.76 10.76L13.23 13.23M8.00 11.90L8.00 15.40M5.24 10.76L2.77 13.23M4.10 8.00L0.60 8.00M5.24 5.24L2.77 2.77M8.00 4.10L8.00 0.60M10.76 5.24L13.23 2.77"
        stroke="currentColor"
        strokeWidth="3.2"
      />
      <circle cx="8" cy="8" r="4.3" stroke="currentColor" strokeWidth="2.6" />
    </svg>
  );
}

export function WarningIcon({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M8 1.5 1 14h14L8 1.5Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M8 6.5v3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="8" cy="12" r="0.9" fill="currentColor" />
    </svg>
  );
}
