/**
 * ============================================================================
 * SplashScreen Component
 * ============================================================================
 *
 * Full-screen overlay shown once on cold start (first OS-level process launch).
 * Renders the Hibiscus icon with a bloom animation, followed by the app name
 * and a tagline.
 *
 * The parent (App.tsx) controls visibility and the exit transition via the
 * `exiting` prop. This component's only job is to call `onDone` after the
 * animation sequence completes.
 *
 * ANIMATION BUDGET: ≤ 1500ms total (1300ms content + 350ms exit transition).
 * ============================================================================
 */

import { useEffect } from "react";
import hibiscusIcon from "../../assets/128x128.png";
import "./SplashScreen.css";

interface SplashScreenProps {
  /** Called when the splash animation sequence is complete. */
  onDone: () => void;
  /** When true, the `.splash-exit` class is applied for the fade-out transition. */
  exiting: boolean;
}

/**
 * Detect whether the user prefers reduced motion.
 * Used to shorten the visible hold duration when animations are disabled.
 */
function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function SplashScreen({ onDone, exiting }: SplashScreenProps) {
  useEffect(() => {
    // With animations: hold for 1300ms (animations finish at ~1100ms + buffer).
    // With reduced motion: no animations play, hold statically for 800ms.
    const duration = prefersReducedMotion() ? 800 : 1300;
    const timer = setTimeout(onDone, duration);
    return () => clearTimeout(timer);
  }, [onDone]);

  return (
    <div className={`splash-overlay${exiting ? " splash-exit" : ""}`}>
      <div className="splash-content">
        <img
          className="splash-icon"
          src={hibiscusIcon}
          alt="Hibiscus"
          width={96}
          height={96}
        />
        <span className="splash-name">Hibiscus</span>
        <span className="splash-tagline">Your space to think</span>
      </div>
    </div>
  );
}
