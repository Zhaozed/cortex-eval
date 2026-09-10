import { useQuery } from "@tanstack/react-query";
import { useState, type ReactElement } from "react";
import type { A2uiReview } from "@cortex-eval/contracts/src/a2ui-review-contracts.ts";
import { a2uiReviewApi } from "../../lib/a2ui-review-api.ts";
import { message } from "../../messages/messages.ts";
import { Button } from "../../components/ui/button.tsx";
import { Progress } from "../../components/ui/progress.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "../../components/ui/table.tsx";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription
} from "../../components/ui/sheet.tsx";
import { reviewStatus as status } from "./review-presentation.ts";

/** Frozen replay evidence is an archive, never an approval surface for live E2E results. */
function ArchivedCase({
  review,
  row
}: {
  readonly review: A2uiReview;
  readonly row: A2uiReview["cases"][number];
}): ReactElement {
  const [imageError, setImageError] = useState(false);
  const history = review.history.filter((event) => event.caseId === row.caseId);
  return (
    <article className="a2ui-review-case">
      <p>
        {message("a2ui.automatic")}: {status(row.automatic)} · {message("a2ui.capture")}:{" "}
        {status(row.capture)} · {message("a2ui.manual")}: {status(row.manual)}
      </p>
      {imageError && <p role="alert">{message("a2ui.archiveImagesError")}</p>}
      {row.images.map((image) => (
        <figure key={image.file}>
          <a
            href={`/api/v1/a2ui-reviews/${review.id}/images/${image.file}`}
            target="_blank"
            rel="noreferrer"
          >
            <img
              src={`/api/v1/a2ui-reviews/${review.id}/images/${image.file}`}
              alt={`${row.caseId} / ${image.groupIndex + 1}`}
              onError={() => setImageError(true)}
            />
          </a>
          <figcaption>
            {image.file} · SHA256 {image.sha256}
          </figcaption>
        </figure>
      ))}
      <h3>{message("a2ui.history")}</h3>
      {history.length === 0 && <p>{message("a2ui.archiveEmptyHistory")}</p>}
      {history.map((event) => (
        <article className="reference-panel" key={event.revision}>
          <p>
            {event.reviewer} · {status(event.verdict)} · {event.at}
          </p>
          <p>{event.note}</p>
          <p>
            {message("a2ui.revision")} {event.revision}
          </p>
        </article>
      ))}
    </article>
  );
}

/** Old bookmarks remain readable; no imports, edits or manual approvals are offered here. */
export function A2uiReviewPage({
  reviewId,
  onNavigate
}: {
  readonly reviewId: string | null;
  readonly onNavigate: (path: string) => void;
}): ReactElement {
  const [selected, setSelected] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["a2ui-reviews"],
    queryFn: a2uiReviewApi.list,
    enabled: reviewId === null
  });
  const detail = useQuery({
    queryKey: ["a2ui-review", reviewId],
    queryFn: () => a2uiReviewApi.get(reviewId ?? ""),
    enabled: reviewId !== null
  });
  const review = detail.data;
  const row = review?.cases.find((item) => item.caseId === selected);
  return (
    <section className="page-stack">
      <header className="page-header split-header">
        <div>
          <h1>{message("a2ui.title")}</h1>
          <p>{message("a2ui.boundary")}</p>
        </div>
        <Button variant="outline" onClick={() => onNavigate("/runs")}>
          {message("runs.back")}
        </Button>
      </header>
      <p className="workspace-notice">{message("a2ui.importHelp")}</p>
      {(list.isError || detail.isError) && <p role="alert">{message("a2ui.error")}</p>}
      {(reviewId === null ? list.isPending : detail.isPending) && (
        <Progress aria-label={message("runs.loading")} />
      )}
      {reviewId === null ? (
        <div className="data-panel">
          {list.data?.length === 0 && <p className="empty-state">{message("workspace.noCases")}</p>}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{message("workspace.templateRuns")}</TableHead>
                <TableHead>{message("a2ui.createdAt")}</TableHead>
                <TableHead>{message("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data?.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>{item.title}</TableCell>
                  <TableCell>{item.createdAt}</TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      onClick={() => onNavigate(`/a2ui-reviews/${item.id}`)}
                    >
                      {message("workspace.inspect")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        review && (
          <>
            <div className="section-heading">
              <h2>{review.title}</h2>
              <Button variant="outline" onClick={() => onNavigate("/a2ui-reviews")}>
                {message("a2ui.archiveReturn")}
              </Button>
            </div>
            <details className="reference-panel">
              <summary>{message("a2ui.archiveEvidence")}</summary>
              <div className="pagination-actions">
                {(["report", "capture", "cases"] as const).map((kind) => (
                  <a
                    className="resource-link"
                    key={kind}
                    href={`/api/v1/a2ui-reviews/${review.id}/evidence/${kind}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {kind}
                  </a>
                ))}
              </div>
            </details>
            <div className="data-panel">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{message("reports.caseKey")}</TableHead>
                    <TableHead>{message("a2ui.automatic")}</TableHead>
                    <TableHead>{message("a2ui.capture")}</TableHead>
                    <TableHead>{message("a2ui.manual")}</TableHead>
                    <TableHead>{message("common.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {review.cases.map((item) => (
                    <TableRow key={item.caseId}>
                      <TableCell>
                        {item.caseId}
                        <p>{item.title}</p>
                      </TableCell>
                      <TableCell>{status(item.automatic)}</TableCell>
                      <TableCell>{status(item.capture)}</TableCell>
                      <TableCell>{status(item.manual)}</TableCell>
                      <TableCell>
                        <Button variant="outline" onClick={() => setSelected(item.caseId)}>
                          {message("workspace.inspect")} {item.caseId}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Sheet
              open={row !== undefined}
              onOpenChange={(open) => {
                if (!open) setSelected(null);
              }}
            >
              <SheetContent className="resource-sheet-content">
                <SheetHeader>
                  <SheetTitle>
                    {message("a2ui.archiveDetail")} · {selected}
                  </SheetTitle>
                  <SheetDescription>{message("a2ui.boundary")}</SheetDescription>
                </SheetHeader>
                {row && (
                  <ArchivedCase key={`${review.id}-${row.caseId}`} review={review} row={row} />
                )}
              </SheetContent>
            </Sheet>
          </>
        )
      )}
    </section>
  );
}
