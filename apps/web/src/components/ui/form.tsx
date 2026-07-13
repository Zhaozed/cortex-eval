import { Slot } from "@radix-ui/react-slot";
import * as React from "react";
import {
  Controller,
  FormProvider,
  useFormContext,
  type ControllerFieldState,
  type ControllerProps,
  type FieldPath,
  type FieldValues
} from "react-hook-form";

import { cn } from "../../lib/class-names.ts";
import { Label } from "./label.tsx";

/** shadcn/ui Form provider. */
export const Form = FormProvider;

interface FormFieldContextValue<TFieldValues extends FieldValues = FieldValues> {
  /** Controlled React Hook Form field name. */
  readonly name: FieldPath<TFieldValues>;
}

interface FormFieldState extends ControllerFieldState {
  /** Stable Form Item identity. */
  readonly id: string;
  /** Controlled field name. */
  readonly name: FieldPath<FieldValues>;
  /** Associated control identity. */
  readonly formItemId: string;
  /** Associated description identity. */
  readonly formDescriptionId: string;
  /** Associated validation-message identity. */
  readonly formMessageId: string;
}

const FormFieldContext = React.createContext<FormFieldContextValue>({} as FormFieldContextValue);

/** shadcn/ui Form field bridge to React Hook Form Controller. */
export function FormField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>
>(props: ControllerProps<TFieldValues, TName>): React.JSX.Element {
  return (
    <FormFieldContext.Provider value={{ name: props.name }}>
      <Controller {...props} />
    </FormFieldContext.Provider>
  );
}

interface FormItemContextValue {
  /** Stable DOM identity shared by label, control and messages. */
  readonly id: string;
}

const FormItemContext = React.createContext<FormItemContextValue>({} as FormItemContextValue);

/** Read current shadcn/ui Form field identities and error. */
export function useFormField(): FormFieldState {
  const fieldContext = React.useContext(FormFieldContext);
  const itemContext = React.useContext(FormItemContext);
  const { getFieldState, formState } = useFormContext();
  const fieldState = getFieldState(fieldContext.name, formState);
  return {
    id: itemContext.id,
    name: fieldContext.name,
    formItemId: `${itemContext.id}-form-item`,
    formDescriptionId: `${itemContext.id}-form-item-description`,
    formMessageId: `${itemContext.id}-form-item-message`,
    ...fieldState
  };
}

/** shadcn/ui Form item grouping. */
export function FormItem({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element {
  const id = React.useId();
  return (
    <FormItemContext.Provider value={{ id }}>
      <div data-slot="form-item" className={cn("grid gap-2", className)} {...props} />
    </FormItemContext.Provider>
  );
}

/** shadcn/ui Form label with error state. */
export function FormLabel({
  className,
  ...props
}: React.ComponentProps<typeof Label>): React.JSX.Element {
  const { error, formItemId } = useFormField();
  return (
    <Label
      data-slot="form-label"
      data-error={Boolean(error)}
      className={cn("data-[error=true]:text-[var(--danger)]", className)}
      htmlFor={formItemId}
      {...props}
    />
  );
}

/** shadcn/ui Form control with ARIA associations. */
export function FormControl(props: React.ComponentProps<typeof Slot>): React.JSX.Element {
  const { error, formItemId, formDescriptionId, formMessageId } = useFormField();
  return (
    <Slot
      data-slot="form-control"
      id={formItemId}
      aria-describedby={error ? `${formDescriptionId} ${formMessageId}` : formDescriptionId}
      aria-invalid={Boolean(error)}
      {...props}
    />
  );
}

/** shadcn/ui Form description. */
export function FormDescription({
  className,
  ...props
}: React.ComponentProps<"p">): React.JSX.Element {
  const { formDescriptionId } = useFormField();
  return (
    <p
      data-slot="form-description"
      id={formDescriptionId}
      className={cn("text-sm text-[var(--muted)]", className)}
      {...props}
    />
  );
}

/** shadcn/ui Form validation message. */
export function FormMessage({
  className,
  children,
  ...props
}: React.ComponentProps<"p">): React.JSX.Element | null {
  const { error, formMessageId } = useFormField();
  const body = error?.message ?? children;
  if (!body) return null;
  return (
    <p
      data-slot="form-message"
      id={formMessageId}
      className={cn("text-sm font-medium text-[var(--danger)]", className)}
      {...props}
    >
      {body}
    </p>
  );
}
