export default function PostsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading posts" className="animate-pulse space-y-2">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="h-10 rounded bg-foreground/10" />
      ))}
    </div>
  );
}
