"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { TerminalIcon } from "lucide-react";

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

export function LoginForm({ className, ...props }: React.ComponentProps<"div">) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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
        setError(body.error ?? "Could not sign in. Please try again.");
        return;
      }

      // `refresh()` discards the cached RSC payload, so the layout re-runs its
      // session check instead of rendering the signed-out shell from cache.
      router.replace("/dashboard");
      router.refresh();
    } catch {
      setError("Could not reach the server. Is it running?");
    } finally {
      setPending(false);
    }
  }

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
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              disabled={pending}
            />
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
              <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4">
                <path
                  fill="currentColor"
                  d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 0-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2 0-.4-.5-1.6.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.6.2 2.8.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3"
                />
              </svg>
              Continue with GitHub
            </Button>
          </Field>
        </FieldGroup>
      </form>
    </div>
  );
}
