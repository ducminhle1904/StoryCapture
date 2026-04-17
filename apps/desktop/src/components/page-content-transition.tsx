import type { PropsWithChildren } from "react";
import { motion, useReducedMotion } from "motion/react";

interface PageContentTransitionProps extends PropsWithChildren {
  className?: string;
}

export function PageContentTransition({
  children,
  className,
}: PageContentTransitionProps) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: reduceMotion ? 0.12 : 0.22,
        ease: [0.22, 1, 0.36, 1],
      }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
