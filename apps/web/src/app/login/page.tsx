import { Suspense } from "react"

import { LoginForm } from "@/components/login-form"

export default function LoginPage() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background p-6 md:p-10">
      <div className="w-full max-w-sm">
        {/* The form reads ?next=, which a static page can only do on the client. */}
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  )
}
