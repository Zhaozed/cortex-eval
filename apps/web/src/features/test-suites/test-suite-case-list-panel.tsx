import type { CaseSummaryV1Schema } from "@cortex-eval/contracts/src/resource-api-contracts.ts";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { Copy, Edit3, Filter, Trash2, X } from "lucide-react";
import { useMemo, type ReactElement } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";

import { Button } from "../../components/ui/button.tsx";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel
} from "../../components/ui/form.tsx";
import { Input } from "../../components/ui/input.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "../../components/ui/table.tsx";
import {
  buildCaseListSearch,
  parseCaseListSearch,
  type CaseListUrlState
} from "../../lib/web-route.ts";
import { formatMessage, message } from "../../messages/messages.ts";
import { CaseListTags } from "./case-list-tags.tsx";

type CaseSummary = z.infer<typeof CaseSummaryV1Schema>;

const FIRST_PAGE = "FIRST_PAGE";

/** User-editable Case filter controls. */
interface CaseFilterForm {
  /** Case ID literal substring. */
  readonly caseKey: string;
  /** Description literal substring. */
  readonly description: string;
  /** Comma-separated business modules. */
  readonly businessModules: string;
  /** Comma-separated scenario tags. */
  readonly scenarioTags: string;
  /** Comma-separated Assertion types. */
  readonly assertionTypes: string;
  /** Comma-separated Metrics. */
  readonly metrics: string;
}

/** Current Case list panel properties. */
export interface TestSuiteCaseListPanelProps {
  /** URL-restorable filters and cursor history. */
  readonly listState: CaseListUrlState;
  /** Current boundary-validated server page. */
  readonly items: CaseSummary[];
  /** Opaque forward cursor, or null on the final page. */
  readonly nextCursor: string | null;
  /** Disable row mutations while Suite deletion owns the write slot. */
  readonly mutationDisabled: boolean;
  /** Commit one new filter or cursor state to the owner. */
  readonly onListStateChange: (state: CaseListUrlState) => void;
  /** Open one current Case for editing. */
  readonly onEdit: (resource: CaseSummary) => void;
  /** Open one current Case copy Draft. */
  readonly onCopy: (resource: CaseSummary) => void;
  /** Open one current Case deletion confirmation. */
  readonly onDelete: (resource: CaseSummary) => void;
}

// Parse comma-separated exact values without retaining blanks.
function commaValues(value: string): readonly string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

// Derive filter controls from refresh-restored URL state.
function filterValues(state: CaseListUrlState): CaseFilterForm {
  return {
    caseKey: state.caseKey,
    description: state.description,
    businessModules: state.businessModules.join(","),
    scenarioTags: state.scenarioTags.join(","),
    assertionTypes: state.assertionTypes.join(","),
    metrics: state.metrics.join(",")
  };
}

// Replace the current URL without causing a document navigation.
function writeCaseListUrl(state: CaseListUrlState): void {
  const search = buildCaseListSearch(state).toString();
  window.history.replaceState(
    window.history.state,
    "",
    search.length === 0 ? window.location.pathname : `${window.location.pathname}?${search}`
  );
}

/** Filter, render and paginate one current server-owned Case page. */
export function TestSuiteCaseListPanel({
  listState,
  items,
  nextCursor,
  mutationDisabled,
  onListStateChange,
  onEdit,
  onCopy,
  onDelete
}: TestSuiteCaseListPanelProps): ReactElement {
  const filters = useForm<CaseFilterForm>({ defaultValues: filterValues(listState) });
  const columns = useMemo<ColumnDef<CaseSummary>[]>(
    () => [
      { accessorKey: "caseKey", header: message("caseList.caseId") },
      { accessorKey: "description", header: message("caseEditor.description") },
      { accessorKey: "businessModule", header: message("caseList.businessModule") },
      { accessorKey: "scenarioTag", header: message("caseList.scenarioTag") },
      {
        accessorKey: "assertionTypes",
        header: message("caseList.assertions"),
        cell: ({ row }): ReactElement => <CaseListTags values={row.original.assertionTypes} />
      },
      {
        accessorKey: "metrics",
        header: message("caseList.metrics"),
        cell: ({ row }): ReactElement => <CaseListTags values={row.original.metrics} />
      },
      { accessorKey: "updatedAt", header: message("common.updatedAt") },
      {
        id: "actions",
        header: message("common.actions"),
        cell: ({ row }): ReactElement => (
          <div className="row-actions">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={mutationDisabled}
              aria-label={formatMessage("caseList.edit", { caseKey: row.original.caseKey })}
              onClick={() => onEdit(row.original)}
            >
              <Edit3 aria-hidden="true" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={mutationDisabled}
              aria-label={formatMessage("caseList.copy", { caseKey: row.original.caseKey })}
              onClick={() => onCopy(row.original)}
            >
              <Copy aria-hidden="true" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={mutationDisabled}
              aria-label={formatMessage("caseList.delete", { caseKey: row.original.caseKey })}
              onClick={() => onDelete(row.original)}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
        )
      }
    ],
    [mutationDisabled, onCopy, onDelete, onEdit]
  );
  const table = useReactTable({
    data: items,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualFiltering: true,
    manualPagination: true
  });

  // Apply all filter fields and reset cursor history atomically.
  const applyFilters = (values: CaseFilterForm): void => {
    const next: CaseListUrlState = {
      caseKey: values.caseKey,
      description: values.description,
      businessModules: commaValues(values.businessModules),
      scenarioTags: commaValues(values.scenarioTags),
      assertionTypes: commaValues(values.assertionTypes),
      metrics: commaValues(values.metrics),
      limit: listState.limit,
      cursor: null,
      before: []
    };
    writeCaseListUrl(next);
    onListStateChange(next);
  };

  return (
    <>
      <div className="filter-panel">
        <Form {...filters}>
          <form
            className="filter-grid"
            onSubmit={(event) => void filters.handleSubmit(applyFilters)(event)}
          >
            <FormField
              control={filters.control}
              name="caseKey"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{message("caseList.caseIdSearch")}</FormLabel>
                  <FormControl>
                    <Input type="search" {...field} />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              control={filters.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{message("caseList.descriptionSearch")}</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                </FormItem>
              )}
            />
            {(
              [
                ["businessModules", "caseList.businessModuleFilter"],
                ["scenarioTags", "caseList.scenarioTagFilter"],
                ["assertionTypes", "caseList.assertionTypeFilter"],
                ["metrics", "caseList.metricFilter"]
              ] as const
            ).map(([name, label]) => (
              <FormField
                key={name}
                control={filters.control}
                name={name}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{message(label)}</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormDescription>{message("caseList.multiValueHint")}</FormDescription>
                  </FormItem>
                )}
              />
            ))}
            <div className="filter-actions">
              <Button type="submit">
                <Filter aria-hidden="true" />
                {message("caseList.applyFilters")}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  const cleared = parseCaseListSearch(new URLSearchParams());
                  filters.reset(filterValues(cleared));
                  writeCaseListUrl(cleared);
                  onListStateChange(cleared);
                }}
              >
                <X aria-hidden="true" />
                {message("caseList.clearFilters")}
              </Button>
            </div>
          </form>
        </Form>
      </div>
      <div className="section-heading">
        <div>
          <h2>{message("caseList.title")}</h2>
          <p>{message("caseList.description")}</p>
        </div>
      </div>
      <div className="data-panel">
        {items.length === 0 ? (
          <p className="empty-state">{message("caseList.empty")}</p>
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
          disabled={listState.before.length === 0}
          onClick={() => {
            const before = [...listState.before];
            const previous = before.pop() ?? FIRST_PAGE;
            const next = {
              ...listState,
              cursor: previous === FIRST_PAGE ? null : previous,
              before
            };
            writeCaseListUrl(next);
            onListStateChange(next);
          }}
        >
          {message("common.previous")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={nextCursor === null}
          onClick={() => {
            const next = {
              ...listState,
              cursor: nextCursor,
              before: [...listState.before, listState.cursor ?? FIRST_PAGE]
            };
            writeCaseListUrl(next);
            onListStateChange(next);
          }}
        >
          {message("common.next")}
        </Button>
      </div>
    </>
  );
}
