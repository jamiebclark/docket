export function CsvProblemList({ problems }: { problems: { line: number | null; message: string }[] }) {
  return (
    <div role="alert" className="rounded border border-danger-border p-3 text-sm">
      <p className="font-medium">This file can&apos;t be used:</p>
      <ul className="mt-1 list-disc pl-5">
        {problems.map((p, i) => (
          <li key={i}>{p.line !== null ? `Line ${p.line}: ${p.message}` : p.message}</li>
        ))}
      </ul>
    </div>
  );
}
