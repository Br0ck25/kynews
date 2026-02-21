import React from "react";

type Props = { className?: string };

export function IconMenu({ className }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  );
}

export function IconBookmark({ className }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path d="M7 4h10a1 1 0 0 1 1 1v16l-6-3-6 3V5a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
    </svg>
  );
}

export function IconToday({ className }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path d="M7 3v3M17 3v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
      <path d="M4 8h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
      <path d="M6 6h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z" stroke="currentColor" strokeWidth="2"/>
      <path d="M8 12h4M8 16h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  );
}

export function IconRss({ className }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path d="M6 18a2 2 0 1 0 0.001 0Z" stroke="currentColor" strokeWidth="2"/>
      <path d="M5 11a8 8 0 0 1 8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
      <path d="M5 5a14 14 0 0 1 14 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  );
}

export function IconSearch({ className }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path d="M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z" stroke="currentColor" strokeWidth="2"/>
      <path d="M16.5 16.5 21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  );
}

export function IconMore({ className }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path d="M5 12h.01M12 12h.01M19 12h.01" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
    </svg>
  );
}

export function IconChevronDown({ className }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

export function IconMapPin({ className }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path
        d="M12 21s6-5.7 6-11a6 6 0 1 0-12 0c0 5.3 6 11 6 11Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="10" r="2.5" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export function IconHeart({ className }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path
        d="M12 21s-6.8-4.6-9.2-8.5c-2.5-4 0.3-9 4.7-9 2 0 3.5 1 4.5 2.4C13 4.5 14.5 3.5 16.5 3.5c4.4 0 7.2 5 4.7 9C18.8 16.4 12 21 12 21Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconShare({ className }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path d="M15 6h5v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M20 6 11 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path
        d="M20 13v4a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconSettings({ className }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path
        d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="m19.4 15.5.3-1.5-1.4-.8a6.7 6.7 0 0 0 0-2.4l1.4-.8-.3-1.5-1.6-.3a6.8 6.8 0 0 0-1.4-1.4l.3-1.6-1.5-.3-.8 1.4a6.7 6.7 0 0 0-2.4 0l-.8-1.4-1.5.3.3 1.6a6.8 6.8 0 0 0-1.4 1.4l-1.6.3-.3 1.5 1.4.8a6.7 6.7 0 0 0 0 2.4l-1.4.8.3 1.5 1.6.3a6.8 6.8 0 0 0 1.4 1.4l-.3 1.6 1.5.3.8-1.4a6.7 6.7 0 0 0 2.4 0l.8 1.4 1.5-.3-.3-1.6a6.8 6.8 0 0 0 1.4-1.4l1.6-.3Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
