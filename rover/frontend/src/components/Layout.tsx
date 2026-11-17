import type { ReactNode } from 'react';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-ink via-ink to-accent flex flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-xl">
        <p className="text-center text-white/90 text-sm tracking-widest uppercase mb-4">Rover</p>
        <div className="w-full bg-white rounded-xl shadow-xl p-8">{children}</div>
      </div>
    </div>
  );
}
