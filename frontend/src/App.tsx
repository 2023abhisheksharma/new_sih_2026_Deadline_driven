import type { FC } from 'react';
import { Header } from './components/Header';
import { AntarcticOverview } from './pages/AntarcticOverview';

export const App: FC = () => {
  return (
    <div className="w-screen h-screen relative overflow-hidden bg-polar-950 text-slate-100 font-sans">
      <Header />
      <main className="w-full h-full">
        <AntarcticOverview />
      </main>
    </div>
  );
};

export default App;
