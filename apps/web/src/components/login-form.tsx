"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { EyeIcon, EyeOffIcon, TerminalIcon } from "lucide-react";

import { BootFrame } from "@/components/boot-frame";
import { GithubMark } from "@/components/github-mark";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// The boot screen brings the client cache and the warmup list with it -- the
// shell's business, not the sign-in form's. It is fetched while the form is
// being filled in, and drawn as a bare frame on the rare submit that beats it.
const loadBootScreen = () => import("@/components/boot-screen");
const BootScreen = dynamic(() => loadBootScreen().then((m) => m.BootScreen), {
  ssr: false,
  // Where the boot screen's own bar starts (`lib/boot-progress.ts`), so it never steps back.
  loading: () => <BootFrame progress={0.04} />,
});

export function LoginForm({ className, ...props }: React.ComponentProps<"div">) {
  const next = useSearchParams().get("next");
  const [signedIn, setSignedIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    void loadBootScreen().catch(() => {});
  }, []);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The session arrives as an HttpOnly cookie, so it is never readable
        // from JavaScript -- including by anything injected into this page.
        credentials: "include",
        body: JSON.stringify({
          email: String(form.get("email") ?? ""),
          password: String(form.get("password") ?? ""),
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        // A 5xx with no JSON body comes from the Next proxy, not the API: the
        // API server is down, which no retry of the password will fix.
        setError(
          body.error ??
            (response.status >= 500
              ? "Could not reach the server. Is it running?"
              : "Could not sign in. Please try again."),
        );
        return;
      }

      // The boot screen loads what the first page needs, then opens it.
      setSignedIn(true);
    } catch {
      setError("Could not reach the server. Is it running?");
    } finally {
      setPending(false);
    }
  }

  if (signedIn) return <BootScreen next={next} />;

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <form onSubmit={onSubmit}>
        <FieldGroup>
          <div className="flex flex-col items-center gap-2 text-center">
            <div className="flex size-9 items-center justify-center rounded-md border">
              <TerminalIcon className="size-5" />
            </div>
            <h1 className="text-xl font-bold">Sign in to UCCH</h1>
            <FieldDescription>Ultra Chill Coding Harness</FieldDescription>
          </div>

          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              required
              disabled={pending}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <div className="relative">
              <Input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                required
                disabled={pending}
                className="pr-9"
              />
              {/* Plain <button> rather than <Button>: this sits inside the
                  input and needs no variant chrome. `type="button"` keeps it
                  from submitting the form. */}
              <button
                type="button"
                onClick={() => setShowPassword((visible) => !visible)}
                disabled={pending}
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-lg text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
              >
                {showPassword ? (
                  <EyeOffIcon className="size-4" aria-hidden="true" />
                ) : (
                  <EyeIcon className="size-4" aria-hidden="true" />
                )}
              </button>
            </div>
          </Field>

          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}

          <Field>
            <Button type="submit" disabled={pending}>
              {pending ? "Signing in…" : "Sign in"}
            </Button>
          </Field>

          <FieldSeparator>Or</FieldSeparator>

          <Field>
            {/* A real navigation rather than fetch: the OAuth route redirects
                to github.com, which no cross-origin fetch may follow.

                `nativeButton={false}` is required because this renders an
                <a>. Base UI assumes a native <button> otherwise, and an
                anchor silently loses button semantics. `type` is omitted for
                the same reason -- it means nothing on an anchor. */}
            <Button
              variant="outline"
              nativeButton={false}
              render={<a href="/api/auth/github" />}
            >
              <GithubMark className="size-4" />
              Continue with GitHub
            </Button>
          </Field>
        </FieldGroup>
      </form>
    </div>
  );
}
