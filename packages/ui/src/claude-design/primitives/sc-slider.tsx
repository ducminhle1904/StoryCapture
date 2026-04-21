import { Slider } from "@base-ui-components/react/slider";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";

import { cn } from "../../lib/cn";

export type ScSliderProps = ComponentPropsWithoutRef<typeof Slider.Root>;

export const ScSlider = forwardRef<ElementRef<typeof Slider.Root>, ScSliderProps>(
  ({ className, min = 0, max = 100, ...props }, ref) => (
    <Slider.Root
      ref={ref}
      min={min}
      max={max}
      className={cn("sc-slider", className)}
      {...props}
    >
      <Slider.Control className="sc-slider-control" style={{ position: "relative", width: "100%", display: "flex", alignItems: "center" }}>
        <Slider.Track className="sc-slider-track">
          <Slider.Indicator className="sc-slider-fill" />
          <Slider.Thumb className="sc-slider-thumb" />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  ),
);
ScSlider.displayName = "ScSlider";
