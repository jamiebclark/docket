/** Signed-in user's name and a Sign out button; `signOut` is a server action (see the sign-out task). */
export function UserMenu({ name, signOut }: { name: string; signOut: () => Promise<void> }) {
  return (
    <form action={signOut} className="flex items-center gap-3 text-sm">
      <span>{name}</span>
      <button
        type="submit"
        className="rounded border border-foreground/30 px-3 py-1.5 hover:bg-foreground/10 focus-visible:ring-2"
      >
        Sign out
      </button>
    </form>
  );
}
