import LoginForm, { LoginSubtitle } from "@/components/auth/LoginForm";
import ForiqLogo from "@/components/ui/ForiqLogo";

export const metadata = {
  title: "Login",
};

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="w-full max-w-sm">
        <div className="mb-10 text-center">
          <ForiqLogo className="mx-auto h-9 w-auto text-foreground" />
          <p className="mt-4 text-sm text-muted-foreground">
            <LoginSubtitle />
          </p>
        </div>
        <LoginForm />
      </div>
    </div>
  );
}
