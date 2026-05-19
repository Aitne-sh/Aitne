"use client";

import { useRef, useState } from "react";
import {
  useBooks,
  useBookHighlights,
  useBooksSummary,
  useImportClippings,
} from "@/lib/hooks/use-books";
import { EmptyState } from "@/components/shared/empty-state";
import { QueryResult, TableSkeleton, CardSkeleton } from "@/components/shared/query-result";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardStatLabel, CardValue } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { formatDate } from "@/lib/utils";
import { BookOpen, Bookmark, Library, Upload } from "lucide-react";
import type { BookRow, ReadingHighlightRow } from "@/lib/api-types";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

interface ImportOutcome {
  kind: "success" | "error";
  message: string;
}

const STATUS_COLORS: Record<string, "blue" | "green" | "gray"> = {
  reading: "blue",
  completed: "green",
  abandoned: "gray",
};

function renderStars(rating: number | null): string {
  if (!rating) return "—";
  return "★".repeat(rating) + "☆".repeat(5 - rating);
}

const PAGE_SIZE = 50;

export default function ReadingPage() {
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedBookId, setSelectedBookId] = useState<number | null>(null);
  const [importOutcome, setImportOutcome] = useState<ImportOutcome | null>(null);
  const [offset, setOffset] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: booksData, isLoading: booksLoading, isError: booksError, error: booksErr, refetch: booksRefetch } = useBooks({ status: statusFilter, limit: PAGE_SIZE, offset });
  const { data: summaryData, isLoading: summaryLoading, isError: summaryError, error: summaryErr, refetch: summaryRefetch } = useBooksSummary(12);
  const { data: highlightsData, isLoading: hlLoading, isError: hlError, error: hlErr, refetch: hlRefetch } = useBookHighlights(selectedBookId);
  const importClippings = useImportClippings();

  const books = booksData?.books ?? [];
  const booksTotal = booksData?.total ?? 0;
  const hasMore = booksData?.hasMore ?? false;
  const rangeStart = books.length === 0 ? 0 : offset + 1;
  const rangeEnd = offset + books.length;
  const highlights = highlightsData?.highlights ?? [];

  const readingCount = summaryData?.byStatus.find((s: { status: string }) => s.status === "reading")?.count ?? 0;
  const completedCount = summaryData?.byStatus.find((s: { status: string }) => s.status === "completed")?.count ?? 0;

  async function handleFileChosen(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    if (file.size > MAX_UPLOAD_BYTES) {
      setImportOutcome({
        kind: "error",
        message: `File is ${(file.size / 1024 / 1024).toFixed(1)} MB; max is 10 MB.`,
      });
      return;
    }

    try {
      const text = await file.text();
      const result = (await importClippings.mutateAsync({ data: text })) as {
        booksFound?: number;
        booksCreated?: number;
        highlightsInserted?: number;
      };
      setImportOutcome({
        kind: "success",
        message: `Imported ${result.booksCreated ?? 0} new book(s) (${result.booksFound ?? 0} total in file) and ${result.highlightsInserted ?? 0} new highlight(s).`,
      });
    } catch (err) {
      setImportOutcome({
        kind: "error",
        message: err instanceof Error ? err.message : "Upload failed.",
      });
    }
  }

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Reading"
        actions={
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,text/plain"
              className="hidden"
              onChange={handleFileChosen}
            />
            <Button
              variant="default"
              onClick={() => fileInputRef.current?.click()}
              disabled={importClippings.isPending}
            >
              <Upload className="h-4 w-4" />
              {importClippings.isPending ? "Importing…" : "Import My Clippings.txt"}
            </Button>
          </>
        }
      />

      {importOutcome && (
        <Alert variant={importOutcome.kind === "error" ? "error" : "success"}>
          <div className="font-semibold">
            {importOutcome.kind === "success" ? "Import complete" : "Import failed"}
          </div>
          <div className="mt-0.5">{importOutcome.message}</div>
        </Alert>
      )}

      {/* Summary cards */}
      <QueryResult isLoading={summaryLoading} isError={summaryError} error={summaryErr} onRetry={() => summaryRefetch()} skeleton={<CardSkeleton count={3} />}>
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardStatLabel>Currently Reading</CardStatLabel>
              <BookOpen className="h-4 w-4 text-blue-500" />
            </CardHeader>
            <CardValue>{readingCount}</CardValue>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardStatLabel>Completed</CardStatLabel>
              <Library className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardValue>{completedCount}</CardValue>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardStatLabel>Total Highlights</CardStatLabel>
              <Bookmark className="h-4 w-4 text-amber-500" />
            </CardHeader>
            <CardValue>{(summaryData?.totalHighlights ?? 0).toLocaleString()}</CardValue>
          </Card>
        </div>
      </QueryResult>

      <Tabs defaultValue="books">
        <TabsList>
          <TabsTrigger value="books">Books</TabsTrigger>
          <TabsTrigger value="highlights">Highlights</TabsTrigger>
        </TabsList>

        <TabsContent value="books" className="mt-4">
          <div className="flex items-center gap-4 mb-4">
            <Select
              value={statusFilter}
              onValueChange={(v) => {
                setStatusFilter(v);
                setOffset(0);
              }}
            >
              <SelectTrigger className="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="reading">Reading</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="abandoned">Abandoned</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <QueryResult isLoading={booksLoading} isError={booksError} error={booksErr} onRetry={() => booksRefetch()} skeleton={<TableSkeleton rows={5} />}>
            {books.length === 0 ? (
              <EmptyState
                icon={BookOpen}
                title="No books yet"
                description="Connect your Kindle (OpenMTP / Send-to-Kindle app) and upload My Clippings.txt using the button above. After the first upload, new highlights sync automatically via the Kindle Notebook Export email pipeline."
              />
            ) : (
              <div className="overflow-auto rounded-xl border border-border">
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted/50">
                    <tr>
                      <th className="text-left py-2 px-3">Title</th>
                      <th className="text-left py-2 px-3">Author</th>
                      <th className="text-center py-2 px-3">Status</th>
                      <th className="text-center py-2 px-3">Rating</th>
                      <th className="text-right py-2 px-3">Highlights</th>
                      <th className="text-left py-2 px-3">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {books.map((book: BookRow) => (
                      <tr
                        key={book.id}
                        className="border-b hover:bg-muted/50 cursor-pointer"
                        onClick={() => setSelectedBookId(book.id)}
                      >
                        <td className="py-2 px-3 font-medium">{book.title}</td>
                        <td className="py-2 px-3 text-muted-foreground">{book.author ?? "—"}</td>
                        <td className="text-center py-2 px-3">
                          <Badge variant={STATUS_COLORS[book.status] ?? "gray"}>
                            {book.status}
                          </Badge>
                        </td>
                        <td className="text-center py-2 px-3 text-amber-500">
                          {renderStars(book.rating)}
                        </td>
                        <td className="text-right py-2 px-3">{book.highlightCount}</td>
                        <td className="py-2 px-3">
                          <Badge variant="gray">{book.source}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {booksTotal > 0 && (
              <div className="flex items-center justify-between mt-3">
                <p className="text-xs text-muted-foreground">
                  Showing {rangeStart}–{rangeEnd} of {booksTotal}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                    disabled={offset === 0}
                  >
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setOffset(offset + PAGE_SIZE)}
                    disabled={!hasMore}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </QueryResult>
        </TabsContent>

        <TabsContent value="highlights" className="mt-4">
          {selectedBookId === null ? (
            <p className="text-muted-foreground text-sm">Select a book from the Books tab to view its highlights.</p>
          ) : (
            <QueryResult isLoading={hlLoading} isError={hlError} error={hlErr} onRetry={() => hlRefetch()} skeleton={<TableSkeleton rows={5} />}>
              {highlights.length === 0 ? (
                <EmptyState icon={Bookmark} title="No highlights" description="This book has no highlights." />
              ) : (
                <div className="space-y-3">
                  {highlights.map((h: ReadingHighlightRow) => (
                    <Card key={h.id} className="p-4">
                      <blockquote className="text-sm border-l-2 border-amber-500 pl-3 italic">
                        {h.content}
                      </blockquote>
                      <div className="flex gap-4 mt-2 text-xs text-muted-foreground">
                        {h.location && <span>Location {h.location}</span>}
                        {h.highlightedAt && <span>{formatDate(h.highlightedAt)}</span>}
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </QueryResult>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
