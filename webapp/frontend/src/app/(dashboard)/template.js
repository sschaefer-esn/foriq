"use client";

import { motion } from "framer-motion";
import { DUR, EASE } from "@/lib/motion";

/**
 * Entrance-only page transition: template.js is guaranteed to remount on every
 * navigation. Exit animations are unreliable in the App Router without
 * blocking navigation, so deliberately only the entrance. A short, pure fade
 * (no y offset) keeps page changes calm.
 */
export default function Template({ children }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: DUR.fast, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}
