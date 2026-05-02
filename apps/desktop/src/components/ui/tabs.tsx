/**
 * Tabs primitive — shadcn-style API on top of Base UI Tabs.
 */

import { Tabs as BaseTabs } from "@base-ui-components/react/tabs";
import * as React from "react";

import { cn } from "@/lib/utils";

export const Tabs = BaseTabs.Root;

export const TabsList = React.forwardRef<
  React.ElementRef<typeof BaseTabs.List>,
  React.ComponentPropsWithoutRef<typeof BaseTabs.List>
>(({ className, children, ...props }, ref) => (
  <BaseTabs.List
    ref={ref}
    className={cn("sc-tabs-list", className)}
    {...props}
  >
    {children}
    <BaseTabs.Indicator className="sc-tabs-indicator" />
  </BaseTabs.List>
));
TabsList.displayName = "TabsList";

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof BaseTabs.Tab>,
  React.ComponentPropsWithoutRef<typeof BaseTabs.Tab>
>(({ className, ...props }, ref) => (
  <BaseTabs.Tab
    ref={ref}
    className={cn("sc-tabs-trigger", className)}
    {...props}
  />
));
TabsTrigger.displayName = "TabsTrigger";

export const TabsContent = React.forwardRef<
  React.ElementRef<typeof BaseTabs.Panel>,
  React.ComponentPropsWithoutRef<typeof BaseTabs.Panel>
>(({ className, ...props }, ref) => (
  <BaseTabs.Panel
    ref={ref}
    className={cn("sc-tabs-content", className)}
    {...props}
  />
));
TabsContent.displayName = "TabsContent";
