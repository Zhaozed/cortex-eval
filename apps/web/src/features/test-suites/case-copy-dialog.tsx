import { useEffect, type ReactElement } from "react";
import { useForm } from "react-hook-form";

import { Alert, AlertTitle } from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../../components/ui/dialog.tsx";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage
} from "../../components/ui/form.tsx";
import { Input } from "../../components/ui/input.tsx";
import { ApiClientError } from "../../lib/api-client.ts";
import { formatMessage, message } from "../../messages/messages.ts";
import {
  CaseMutationConflictNotice,
  type CaseMutationConflict
} from "./case-mutation-conflict-notice.tsx";

/** Case copy Dialog properties. */
export interface CaseCopyDialogProps {
  /** Source Case identity, or null while the Dialog is closed. */
  readonly sourceCaseKey: string | null;
  /** Notify the detail page when visibility changes. */
  readonly onOpenChange: (open: boolean) => void;
  /** Copy the source Case and report whether the mutation succeeded. */
  readonly onCopy: (newCaseKey: string) => Promise<boolean>;
  /** Current copy conflict decision, when the source Suite changed. */
  readonly conflict: CaseMutationConflict | null;
  /** Whether one Case mutation is currently in flight. */
  readonly pending: boolean;
  /** Sanitized non-Revision failure retained inside the Dialog. */
  readonly error: ApiClientError | null;
}

interface CaseCopyForm {
  /** New Suite-local Case identity. */
  readonly newCaseKey: string;
}

/** Focused Case copy confirmation with a retained Draft on mutation failure. */
export function CaseCopyDialog({
  sourceCaseKey,
  onOpenChange,
  onCopy,
  conflict,
  pending,
  error
}: CaseCopyDialogProps): ReactElement {
  const form = useForm<CaseCopyForm>({ defaultValues: { newCaseKey: "" } });

  useEffect(() => {
    if (sourceCaseKey !== null) form.reset({ newCaseKey: `${sourceCaseKey}-copy` });
  }, [form, sourceCaseKey]);

  useEffect(() => {
    if (error === null) {
      form.clearErrors("newCaseKey");
      return;
    }
    const path = error instanceof ApiClientError ? error.fieldPath : null;
    form.setError("newCaseKey", {
      type: "server",
      message:
        path === null
          ? message("common.operationFailed")
          : formatMessage("caseEditor.serverFieldInvalid", { path })
    });
    form.setFocus("newCaseKey");
  }, [error, form]);

  return (
    <Dialog open={sourceCaseKey !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {formatMessage("caseList.copyTitle", { caseKey: sourceCaseKey ?? "" })}
          </DialogTitle>
          <DialogDescription>{message("caseList.copyDescription")}</DialogDescription>
        </DialogHeader>
        {conflict === null ? null : (
          <CaseMutationConflictNotice conflict={conflict} pending={pending} />
        )}
        {error === null ? null : (
          <Alert variant="destructive">
            <AlertTitle>{message("common.operationFailed")}</AlertTitle>
          </Alert>
        )}
        <Form {...form}>
          <form
            onSubmit={(event) =>
              void form.handleSubmit(async (values) => {
                if (await onCopy(values.newCaseKey)) onOpenChange(false);
              })(event)
            }
          >
            <FormField
              control={form.control}
              name="newCaseKey"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{message("caseList.newCaseKey")}</FormLabel>
                  <FormControl>
                    <Input {...field} disabled={pending || conflict !== null} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="submit" disabled={pending || conflict !== null}>
                {message("caseList.copyConfirm")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
