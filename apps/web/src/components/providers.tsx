"use client";
import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "@/lib/api";

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => {
    const queryClient: QueryClient = new QueryClient({
      queryCache: new QueryCache({
        // Any 401 means the workspace session ended: recheck it once, so the
        // shell can offer a fresh workspace instead of failing card by card.
        onError: (error, query) => {
          if (
            error instanceof ApiError &&
            error.status === 401 &&
            query.queryKey[0] !== "session"
          )
            void queryClient.invalidateQueries({ queryKey: ["session"] });
        },
      }),
      defaultOptions: {
        queries: {
          staleTime: 1000,
          // Client errors (not found, expired) are final; retry server hiccups once.
          retry: (count, error) =>
            !(error instanceof ApiError && error.status < 500) && count < 1,
        },
      },
    });
    return queryClient;
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
