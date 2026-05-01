import {
  Children,
  cloneElement,
  forwardRef,
  type HTMLAttributes,
  isValidElement,
  type LabelHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";

import { cn } from "../../lib/cn";

type FieldControlElement = ReactElement<{
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "false" | "true";
  id?: string;
}>;

export interface ScFieldProps extends HTMLAttributes<HTMLDivElement> {
  label: ReactNode;
  helper?: ReactNode;
  error?: ReactNode;
  meta?: ReactNode;
  htmlFor?: string;
  labelProps?: LabelHTMLAttributes<HTMLLabelElement>;
}

export const ScField = forwardRef<HTMLDivElement, ScFieldProps>(
  ({ label, helper, error, meta, htmlFor, labelProps, className, children, id, ...rest }, ref) => {
    const fieldId = id ?? htmlFor;
    const helperId = helper && fieldId ? `${fieldId}-helper` : undefined;
    const errorId = error && fieldId ? `${fieldId}-error` : undefined;
    const describedBy = [helperId, errorId].filter(Boolean).join(" ") || undefined;

    const enhancedChildren = Children.map(children, (child) => {
      if (!isValidElement(child) || !fieldId) return child;

      const control = child as FieldControlElement;
      const childDescribedBy = control.props["aria-describedby"];
      const mergedDescribedBy =
        [childDescribedBy, describedBy].filter(Boolean).join(" ") || undefined;

      return cloneElement(control, {
        "aria-describedby": mergedDescribedBy,
        "aria-invalid": error ? true : control.props["aria-invalid"],
        id: control.props.id ?? fieldId,
      });
    });

    return (
      <div ref={ref} className={cn("sc-field", error && "invalid", className)} {...rest}>
        <div className="sc-field-row">
          <label
            className={cn("sc-field-label", labelProps?.className)}
            htmlFor={fieldId}
            {...labelProps}
          >
            {label}
          </label>
          {meta && <span className="sc-field-meta">{meta}</span>}
        </div>
        {enhancedChildren}
        {helper && (
          <div id={helperId} className="sc-field-helper">
            {helper}
          </div>
        )}
        {error && (
          <div id={errorId} className="sc-field-error" role="alert">
            {error}
          </div>
        )}
      </div>
    );
  },
);
ScField.displayName = "ScField";
