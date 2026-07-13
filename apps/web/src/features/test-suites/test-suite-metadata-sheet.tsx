import type { UseFormReturn } from "react-hook-form";
import type { ReactElement } from "react";

import { Alert, AlertTitle } from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage
} from "../../components/ui/form.tsx";
import { Input } from "../../components/ui/input.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from "../../components/ui/sheet.tsx";
import { message } from "../../messages/messages.ts";
import { SuiteConflictNotice, type SuiteEditorConflict } from "./test-suite-notices.tsx";

/** Editable Test Suite metadata fields. */
export interface TestSuiteMetadataForm {
  /** Human-readable Test Suite name. */
  readonly name: string;
  /** Human-readable Test Suite description. */
  readonly description: string;
}

/** Test Suite metadata Sheet properties. */
export interface TestSuiteMetadataSheetProps {
  /** Whether the Sheet is visible. */
  readonly open: boolean;
  /** React Hook Form state owned by the detail page. */
  readonly form: UseFormReturn<TestSuiteMetadataForm>;
  /** Explicit local Draft and current server Snapshot. */
  readonly conflict: SuiteEditorConflict | null;
  /** Whether persistence or conflict recovery is in flight. */
  readonly pending: boolean;
  /** Whether the last operation failed outside a locatable field. */
  readonly error: boolean;
  /** Notify the page when visibility changes. */
  readonly onOpenChange: (open: boolean) => void;
  /** Persist the current metadata Draft. */
  readonly onSave: (values: TestSuiteMetadataForm) => Promise<void>;
  /** Retry the Draft against the latest server revision. */
  readonly onRetry: () => void;
  /** Replace the Draft with the current server Snapshot. */
  readonly onAccept: () => void;
}

/** Focused metadata editor kept separate from Case workflow orchestration. */
export function TestSuiteMetadataSheet({
  open,
  form,
  conflict,
  pending,
  error,
  onOpenChange,
  onSave,
  onRetry,
  onAccept
}: TestSuiteMetadataSheetProps): ReactElement {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{message("testSuites.editTitle")}</SheetTitle>
          <SheetDescription>{message("config.sheetDescription")}</SheetDescription>
        </SheetHeader>
        <Form {...form}>
          <form
            className="form-stack"
            onSubmit={(event) => void form.handleSubmit((values) => void onSave(values))(event)}
          >
            <fieldset className="editor-fieldset" disabled={pending || conflict !== null}>
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{message("testSuites.name")}</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{message("testSuites.descriptionField")}</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </fieldset>
            {conflict === null ? null : (
              <SuiteConflictNotice
                conflict={conflict}
                onRetry={onRetry}
                onAccept={onAccept}
                retryDisabled={pending}
                acceptDisabled={pending}
              />
            )}
            {error ? (
              <Alert variant="destructive">
                <AlertTitle>{message("common.operationFailed")}</AlertTitle>
              </Alert>
            ) : null}
            <div className="editor-actions">
              <Button type="submit" disabled={pending || conflict !== null}>
                {message("testSuites.save")}
              </Button>
            </div>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  );
}
