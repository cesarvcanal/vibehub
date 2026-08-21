import { Providers } from "@/providers/providers";
import { AppRoutes } from "@/routes";

export default function App() {
  return (
    <Providers>
      <AppRoutes />
    </Providers>
  );
}
