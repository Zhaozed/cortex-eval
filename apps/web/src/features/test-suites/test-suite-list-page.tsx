import type { TestSuiteSummaryV1 } from "@cortex-eval/contracts/src/resource-api-contracts.ts";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { Plus, RefreshCw } from "lucide-react";
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement
} from "react";
import { useForm } from "react-hook-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert.tsx";
import { Badge } from "../../components/ui/badge.tsx";
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
import { Progress } from "../../components/ui/progress.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle
} from "../../components/ui/sheet.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "../../components/ui/table.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { ApiClientError } from "../../lib/api-client.ts";
import { usePageLeaveBlocker } from "../../lib/use-page-leave-blocker.ts";
import { formatMessage, message } from "../../messages/messages.ts";
import {
  invalidateTestSuiteMutation,
  testSuitePageQuery,
  type ResourceApi
} from "../../lib/resource-api.ts";

/** Test Suite list page properties. */
export interface TestSuiteListPageProps {
  /** Boundary-validating resource API. */
  readonly api: ResourceApi;
  /** Explicit History navigation callback. */
  readonly onNavigate: (path: string) => void;
  /** Navigate after the only in-flight create has committed successfully. */
  readonly onCommittedNavigate?: (path: string) => void;
  /** Report an in-flight create that must not be abandoned by navigation. */
  readonly onLeaveBlockedChange?: (blocked: boolean) => void;
}

/** New Test Suite form values. */
interface CreateSuiteForm {
  /** Unique display name. */
  readonly name: string;
  /** Human-readable purpose. */
  readonly description: string;
}

// Display one stable local date without implying server timezone conversion semantics.
function displayDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(value));
}

/** Cursor-paged current Test Suite registry. */
export function TestSuiteListPage({
  api,
  onNavigate,
  onCommittedNavigate,
  onLeaveBlockedChange
}: TestSuiteListPageProps): ReactElement {
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<readonly (string | null)[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const createPendingRef = useRef(false);
  const [createErrorField, setCreateErrorField] = useState<keyof CreateSuiteForm | null>(null);
  const queryClient = useQueryClient();
  const page = useQuery(testSuitePageQuery(api, { limit: 50, cursor }));
  const form = useForm<CreateSuiteForm>({ defaultValues: { name: "", description: "" } });
  const create = useMutation({
    mutationFn: (values: CreateSuiteForm) =>
      api.createTestSuite(values, new AbortController().signal),
    onSuccess: async (suite) => {
      await invalidateTestSuiteMutation(queryClient, suite.id);
      form.reset();
      setCreateOpen(false);
      (onCommittedNavigate ?? onNavigate)(`/test-suites/${encodeURIComponent(suite.id)}`);
    },
    onError: (error) => {
      if (!(error instanceof ApiClientError)) return;
      if (error.fieldPath !== "name" && error.fieldPath !== "description") return;
      setCreateErrorField(error.fieldPath);
      form.setError(error.fieldPath, {
        type: "server",
        message: formatMessage("config.serverFieldInvalid", { path: error.fieldPath })
      });
    }
  });

  useLayoutEffect(() => {
    if (create.isPending || createErrorField === null) return;
    form.setFocus(createErrorField);
    setCreateErrorField(null);
  }, [create.isPending, createErrorField, form]);
  usePageLeaveBlocker(create.isPending, onLeaveBlockedChange);

  // Execute one create request at a time and retain the Sheet until it settles.
  const submitCreate = async (values: CreateSuiteForm): Promise<void> => {
    if (createPendingRef.current) return;
    createPendingRef.current = true;
    try {
      await create.mutateAsync(values);
    } catch {
      // The typed mutation error is rendered and focused by the mutation callbacks.
    } finally {
      createPendingRef.current = false;
    }
  };
  const columns = useMemo<ColumnDef<TestSuiteSummaryV1>[]>(
    () => [
      {
        accessorKey: "name",
        header: message("testSuites.name"),
        cell: ({ row }): ReactElement => (
          <a
            href={`/test-suites/${encodeURIComponent(row.original.id)}`}
            className="resource-link"
            onClick={(event: MouseEvent<HTMLAnchorElement>) => {
              event.preventDefault();
              onNavigate(`/test-suites/${encodeURIComponent(row.original.id)}`);
            }}
          >
            {row.original.name}
          </a>
        )
      },
      { accessorKey: "description", header: message("testSuites.descriptionField") },
      {
        accessorKey: "caseCount",
        header: message("testSuites.caseCount"),
        cell: ({ row }): ReactElement => <Badge variant="outline">{row.original.caseCount}</Badge>
      },
      {
        accessorKey: "updatedAt",
        header: message("common.updatedAt"),
        cell: ({ row }): string => displayDate(row.original.updatedAt)
      }
    ],
    [onNavigate]
  );
  const table = useReactTable({
    data: page.data?.items ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true
  });

  if (page.isPending) {
    return (
      <section className="page-stack" aria-busy="true">
        <h1>{message("testSuites.title")}</h1>
        <Progress aria-label={message("testSuites.loading")} />
      </section>
    );
  }
  if (page.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>{message("testSuites.loadError")}</AlertTitle>
        <Button type="button" variant="outline" onClick={() => void page.refetch()}>
          <RefreshCw aria-hidden="true" />
          {message("dashboard.retry")}
        </Button>
      </Alert>
    );
  }

  return (
    <section className="page-stack">
      <header className="page-header split-header">
        <div>
          <p className="eyebrow">{message("testSuites.eyebrow")}</p>
          <h1>{message("testSuites.title")}</h1>
          <p>{message("testSuites.description")}</p>
        </div>
        <Button
          type="button"
          onClick={() => {
            form.reset();
            create.reset();
            setCreateOpen(true);
          }}
        >
          <Plus aria-hidden="true" />
          {message("testSuites.create")}
        </Button>
      </header>
      <div className="data-panel">
        {page.data.items.length === 0 ? (
          <p className="empty-state">{message("testSuites.empty")}</p>
        ) : (
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id}>
                  {group.headers.map((header) => (
                    <TableHead key={header.id}>
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      <div className="pagination-controls">
        <Button
          type="button"
          variant="outline"
          disabled={history.length === 0}
          onClick={() => {
            const previous = history.at(-1) ?? null;
            setHistory(history.slice(0, -1));
            setCursor(previous);
          }}
        >
          {message("common.previous")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={page.data.nextCursor === null}
          onClick={() => {
            setHistory([...history, cursor]);
            setCursor(page.data.nextCursor);
          }}
        >
          {message("common.next")}
        </Button>
      </div>
      <Sheet
        open={createOpen}
        onOpenChange={(open) => {
          if (!open && createPendingRef.current) return;
          setCreateOpen(open);
        }}
      >
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{message("testSuites.createTitle")}</SheetTitle>
            <SheetDescription>{message("testSuites.createDescription")}</SheetDescription>
          </SheetHeader>
          <Form {...form}>
            <form
              className="form-stack"
              onSubmit={(event) =>
                void form.handleSubmit((values) => void submitCreate(values))(event)
              }
            >
              <fieldset className="editor-fieldset" disabled={create.isPending}>
                <FormField
                  control={form.control}
                  name="name"
                  rules={{ required: message("common.required") }}
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
                        <Textarea rows={6} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </fieldset>
              {create.isError ? (
                <Alert variant="destructive">
                  <AlertTitle>{message("testSuites.mutationError")}</AlertTitle>
                  <AlertDescription>{message("dashboard.errorDescription")}</AlertDescription>
                </Alert>
              ) : null}
              <SheetFooter>
                <Button type="submit" disabled={create.isPending}>
                  {create.isPending
                    ? message("testSuites.creating")
                    : message("testSuites.createSubmit")}
                </Button>
              </SheetFooter>
            </form>
          </Form>
        </SheetContent>
      </Sheet>
    </section>
  );
}
