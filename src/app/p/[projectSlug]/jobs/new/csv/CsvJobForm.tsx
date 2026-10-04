"use client";

import { useState } from "react";
import { validateCsvAction, type CsvValidation } from "../../actions";
import type { JobFormData } from "../form-data";
import { JobForm } from "../JobForm";

type Props = { slug: string; form: JobFormData };

export function CsvProblemList({ problems }: { problems: { line: number | null; message: string }[] }) {
  return (
    <div role="alert" className="rounded border border-red-300 p-3 text-sm">
      <p className="font-medium">This file can&apos;t be used:</p>
      <ul className="mt-1 list-disc pl-5">
        {problems.map((p, i) => (
          <li key={i}>{p.line !== null ? `Line ${p.line}: ${p.message}` : p.message}</li>
        ))}
      </ul>
    </div>
  );
}

export function CsvJobForm({ slug, form }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<CsvValidation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onChange(next: File | null) {
    setFile(next);
    setResult(null);
    setError(null);
    if (!next) return;
    setBusy(true);
    const body = new FormData();
    body.set("file", next);
    const res = await validateCsvAction(slug, body);
    setBusy(false);
    if (res.ok) setResult(res.data);
    else setError(res.message);
  }

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="csv-file" className="block text-sm font-medium">
          CSV file
        </label>
        <input
          id="csv-file"
          type="file"
          accept=".csv,text/csv"
          className="mt-1 block text-sm"
          onChange={(e) => void onChange(e.target.files?.[0] ?? null)}
        />
        <p className="mt-1 text-sm text-neutral-600">
          The first row names the columns. Up to 500 rows and 1 MB. Use a column in your instructions as {"{{column}}"}.
        </p>
      </div>
      {busy && <p role="status">Checking the file…</p>}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {result && !result.ok && <CsvProblemList problems={result.problems} />}
      {result && result.ok && (
        <div className="space-y-3">
          <p role="status" className="text-sm">
            {result.rowCount} rows, {result.columns.length} columns: {result.columns.join(", ")}
          </p>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <caption className="sr-only">First rows of {result.filename}</caption>
              <thead>
                <tr>
                  {result.columns.map((c) => (
                    <th key={c} scope="col" className="px-2 py-1 font-medium">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.preview.map((row) => (
                  <tr key={row.line}>
                    {result.columns.map((c) => (
                      <td key={c} className="max-w-64 truncate px-2 py-1">
                        {row.values[c]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {file && (
            <JobForm
              key={`${result.filename}-${result.rowCount}`}
              slug={slug}
              source={{ kind: "csv", file }}
              summary={
                <p className="text-sm">
                  {result.filename}: {result.rowCount} rows; columns: {result.columns.join(", ")}
                </p>
              }
              itemCount={result.rowCount}
              fields={result.columns}
              firstFields={result.preview[0]?.values ?? null}
              emptyByField={result.emptyByField}
              defaultTemplate={`Write a post about {{${result.columns[0]}}}.`}
              {...form}
            />
          )}
        </div>
      )}
    </div>
  );
}
