import { IconLoader2 } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { cn } from "@/utils/classnames";
import { pb } from "@/services/pocketbase";
import { formHandler } from "@/utils/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Link, useRouter } from "@tanstack/react-router";
import { useFormState } from "@/hooks/use-form-state";
import { FormError, FormField, FormLabel } from "@/components/ui/form";
import {
  type AuthMethodsList,
  type AuthProviderInfo,
  ClientResponseError,
} from "pocketbase";

const SocialAuth = ({
  providers,
  redirect,
}: {
  providers: AuthProviderInfo[];
  redirect?: string;
}) => {
  const router = useRouter();

  const [loading, setLoading] = useState<string>();

  const login = async (provider: string) => {
    setLoading(provider);

    const openWindow = window.open();

    await pb
      .collection("users")
      .authWithOAuth2({
        provider,
        urlCallback: (url) => {
          if (openWindow) openWindow.location.href = url;
        },
      })
      .then(() => {
        if (redirect) return router.navigate({ href: redirect });

        return router.navigate({ to: "/" });
      })
      .finally(() => setLoading(undefined));
  };

  return (
    <div className="flex flex-col gap-2">
      {providers.map((provider) => (
        <Button
          type="button"
          key={provider.name}
          variant="outline"
          disabled={!!loading}
          className="space-x-2"
          onClick={() => login(provider.name)}
        >
          {loading === provider.name ? (
            <IconLoader2 className="size-4 animate-spin" />
          ) : (
            <img
              className="size-4"
              alt={`${provider.displayName} logo`}
              src={pb.buildURL(`/_/images/oauth2/${provider.name}.svg`)}
            />
          )}
          <span>Continue with {provider.displayName}</span>
        </Button>
      ))}
    </div>
  );
};

/**
 * login form
 *
 * @returns
 */
export const LoginForm = ({ redirect }: { redirect?: string }) => {
  const router = useRouter();

  const [authMethods, setAuthMethods] = useState<AuthMethodsList>();

  useEffect(() => {
    pb.collection("users")
      .listAuthMethods()
      .then(setAuthMethods)
      /** backend unreachable: fall back to no oauth providers */
      .catch(() => setAuthMethods(undefined));
  }, []);

  const providers = authMethods?.oauth2.providers ?? [];

  const form = useFormState({
    defaultValue: { identity: "", password: "" },
    validations: {
      identity: (value) =>
        !value.trim() ? "Email cannot be blank" : undefined,
      password: (value) =>
        !value.trim() ? "Password cannot be blank" : undefined,
    },
  });

  const loginWithPassword = () =>
    form.submit(async (data) => {
      pb.collection("users")
        .authWithPassword(data.identity, data.password)
        .then(() =>
          redirect
            ? router.navigate({ href: redirect })
            : router.navigate({ to: "/" }),
        )
        .catch(async (err) => {
          if (err instanceof ClientResponseError)
            if (err.status === 403)
              /**
               * if current user is unverified it will
               * return 403, so we send verification link
               * to their email.
               */
              await pb
                .collection("users")
                .requestVerification(data.identity)
                .then(() => {
                  return router.navigate({
                    to: "/auth/email-verification",
                    search: { email: data.identity },
                  });
                })
                .catch(() => ({}));

          return form.setError("identity", (err as Error).message);
        });
    });

  return (
    <form
      onSubmit={formHandler(loginWithPassword)}
      className="m-auto flex flex-col gap-3 p-2"
    >
      {(authMethods?.password.enabled ?? true) && (
        <>
          <FormField>
            <FormLabel error={!!form.errors?.identity} htmlFor="identity">
              Email
            </FormLabel>
            <Input
              name="identity"
              value={form.data.identity}
              disabled={form.isSubmitting}
              placeholder="email@example.com"
              onChange={(e) => form.setValue("identity", e.target.value)}
              className={cn(
                !!form.errors?.identity &&
                  "border-destructive focus-visible:ring-destructive",
              )}
            />
            <FormError>{form.errors?.identity}</FormError>
          </FormField>

          <FormField>
            <FormLabel error={!!form.errors?.password} htmlFor="password">
              Password
            </FormLabel>
            <Input
              name="password"
              type="password"
              value={form.data.password}
              disabled={form.isSubmitting}
              onChange={(e) => form.setValue("password", e.target.value)}
              className={cn(
                !!form.errors?.password &&
                  "border-destructive focus-visible:ring-destructive",
              )}
            />
            <FormError>{form.errors?.password}</FormError>
          </FormField>

          <Label asChild>
            <Link to="/auth/password-reset">Forgot Password?</Link>
          </Label>

          <Button
            type="submit"
            className="space-x-2"
            disabled={form.isSubmitting}
          >
            {form.isSubmitting && (
              <IconLoader2 className="size-4 animate-spin" />
            )}
            <span>Login</span>
          </Button>

          <div className="text-center text-sm">
            <span>No Account Yet? </span>
            <Link to="/auth/register" className="font-bold">
              Register
            </Link>
          </div>
        </>
      )}

      {providers.length > 0 && (
        <>
          {(authMethods?.password.enabled ?? true) && <Separator />}

          <SocialAuth providers={providers} redirect={redirect} />
        </>
      )}
    </form>
  );
};

/**
 * register form
 *
 * @returns
 */
export const RegisterForm = () => {
  const router = useRouter();

  const form = useFormState({
    defaultValue: {
      name: "",
      email: "",
      password: "",
      passwordConfirm: "",
    },
    validations: {
      name: (value) =>
        !value.trim() ? "Your Name cannot be blank" : undefined,
      email: (value) =>
        !value.trim()
          ? "Email cannot be blank"
          : !value.includes("@")
            ? "Email not valid"
            : undefined,
      password: (value) =>
        !value.trim()
          ? "Password cannot be blank"
          : value.length < 8
            ? "Password minimum 8 characters"
            : undefined,
      passwordConfirm: (value, data) =>
        !value.trim()
          ? "Password confirmation cannot be blank"
          : data.password !== value
            ? "password confirmation does not match"
            : undefined,
    },
  });

  const register = () =>
    form.submit(async (data) => {
      pb.collection("users")
        .create(data)
        .then(() => {
          pb.collection("users")
            .requestVerification(data.email)
            .then(() => {
              return router.navigate({
                to: "/auth/email-verification",
                search: { email: data.email },
              });
            });
        })
        .catch((err) => {
          if (!(err instanceof ClientResponseError))
            return form.setError("name", (err as Error).message);

          if (!err.data.data) return form.setError("name", err.message);

          for (const key in err.data.data)
            form.setError(
              key as keyof typeof form.data,
              err.data.data[key].message,
            );
        });
    });

  return (
    <form
      onSubmit={formHandler(register)}
      className="m-auto flex flex-col gap-3 p-2"
    >
      <FormField>
        <FormLabel error={!!form.errors?.name} htmlFor="name">
          Name
        </FormLabel>
        <Input
          name="name"
          value={form.data.name}
          disabled={form.isSubmitting}
          onChange={(e) => form.setValue("name", e.target.value)}
          className={cn(
            !!form.errors?.name &&
              "border-destructive focus-visible:ring-destructive",
          )}
        />
        <FormError>{form.errors?.name}</FormError>
      </FormField>

      <FormField>
        <FormLabel error={!!form.errors?.email} htmlFor="email">
          Email
        </FormLabel>
        <Input
          name="email"
          type="email"
          value={form.data.email}
          disabled={form.isSubmitting}
          placeholder="email@example.com"
          onChange={(e) => form.setValue("email", e.target.value)}
          className={cn(
            !!form.errors?.email &&
              "border-destructive focus-visible:ring-destructive",
          )}
        />
        <FormError>{form.errors?.email}</FormError>
      </FormField>

      <FormField>
        <FormLabel error={!!form.errors?.password} htmlFor="password">
          Password
        </FormLabel>
        <Input
          name="password"
          type="password"
          value={form.data.password}
          disabled={form.isSubmitting}
          onChange={(e) => form.setValue("password", e.target.value)}
          className={cn(
            !!form.errors?.password &&
              "border-destructive focus-visible:ring-destructive",
          )}
        />
        <FormError>{form.errors?.password}</FormError>
      </FormField>

      <FormField>
        <FormLabel
          error={!!form.errors?.passwordConfirm}
          htmlFor="passwordConfirm"
        >
          Password Confirmation
        </FormLabel>
        <Input
          type="password"
          name="passwordConfirm"
          value={form.data.passwordConfirm}
          disabled={form.isSubmitting}
          onChange={(e) => form.setValue("passwordConfirm", e.target.value)}
          className={cn(
            !!form.errors?.passwordConfirm &&
              "border-destructive focus-visible:ring-destructive",
          )}
        />
        <FormError>{form.errors?.passwordConfirm}</FormError>
      </FormField>

      <Button type="submit" className="space-x-2" disabled={form.isSubmitting}>
        {form.isSubmitting && <IconLoader2 className="size-4 animate-spin" />}
        <span>Register</span>
      </Button>

      <Separator />

      <Button asChild type="button" variant="outline">
        <Link to="/auth/login">Back to login</Link>
      </Button>
    </form>
  );
};
