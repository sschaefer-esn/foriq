// Central motion tokens: one language for all animations in the app.
// Subtle, fast, physically plausible — no bounce effects.

// Durations in seconds (Framer Motion) — CSS counterparts in globals.css
export const DUR = { fast: 0.15, base: 0.25, slow: 0.4 };

// Apple-style ease-out: quick start, very soft settle
export const EASE = [0.32, 0.72, 0, 1];

// Bounce-free spring for layout animations (tab indicator etc.)
export const SPRING = { type: "spring", stiffness: 380, damping: 34, mass: 0.9 };

// --- Reusable variants ---

export const fadeRise = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: { duration: DUR.base, ease: EASE } },
};

export const staggerContainer = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04 } },
};

export const scaleIn = {
  hidden: { opacity: 0, scale: 0.92 },
  visible: { opacity: 1, scale: 1, transition: { duration: DUR.fast, ease: EASE } },
};

export const listItem = {
  hidden: { opacity: 0, y: 4 },
  visible: { opacity: 1, y: 0, transition: { duration: DUR.fast, ease: EASE } },
};
