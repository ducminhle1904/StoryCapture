import { Tabs } from "@base-ui/react/tabs";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";

import { cn } from "../../lib/cn";

export const ScTabs = Tabs.Root;

export const ScTabsList = forwardRef<
  ElementRef<typeof Tabs.List>,
  ComponentPropsWithoutRef<typeof Tabs.List>
>(({ className, children, ...props }, ref) => (
  <Tabs.List ref={ref} className={cn("sc-tabs-list", className)} {...props}>
    {children}
    <Tabs.Indicator className="sc-tabs-indicator" />
  </Tabs.List>
));
ScTabsList.displayName = "ScTabsList";

export const ScTabsTrigger = forwardRef<
  ElementRef<typeof Tabs.Tab>,
  ComponentPropsWithoutRef<typeof Tabs.Tab>
>(({ className, ...props }, ref) => (
  <Tabs.Tab ref={ref} className={cn("sc-tabs-trigger", className)} {...props} />
));
ScTabsTrigger.displayName = "ScTabsTrigger";

export const ScTabsContent = forwardRef<
  ElementRef<typeof Tabs.Panel>,
  ComponentPropsWithoutRef<typeof Tabs.Panel>
>(({ className, ...props }, ref) => (
  <Tabs.Panel ref={ref} className={cn("sc-tabs-content", className)} {...props} />
));
ScTabsContent.displayName = "ScTabsContent";
