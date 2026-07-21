import { Slider } from "@base-ui/react/slider";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";

import { cn } from "../../lib/cn";

export type ScSliderProps = ComponentPropsWithoutRef<typeof Slider.Root>;

export const ScSlider = forwardRef<ElementRef<typeof Slider.Root>, ScSliderProps>(
  (
    {
      className,
      min = 0,
      max = 100,
      "aria-label": ariaLabel,
      "aria-labelledby": ariaLabelledBy,
      ...props
    },
    ref,
  ) => (
    <Slider.Root
      ref={ref}
      min={min}
      max={max}
      className={cn("sc-slider", className)}
      {...props}
    >
      <Slider.Control className="sc-slider-control">
        <Slider.Track className="sc-slider-track">
          <Slider.Indicator className="sc-slider-fill" />
        </Slider.Track>
        <Slider.Thumb
          className="sc-slider-thumb"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
        />
      </Slider.Control>
    </Slider.Root>
  ),
);
ScSlider.displayName = "ScSlider";
