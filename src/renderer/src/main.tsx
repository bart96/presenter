import './assets/main.css';
import 'react-pdf/dist/Page/TextLayer.css';
import 'react-pdf/dist/Page/AnnotationLayer.css';

import { StrictMode } from 'react';
import { mountRoot } from './mountRoot';
import App from './App';
import { CssBaseline } from '@mui/material';
import { Provider } from 'react-redux';
import { store } from '@/store';
import { installClientErrorLog } from '@/utils/clientErrorLog';

// Before the first render: a crash while the app is still coming up is the one nobody can
// describe afterwards, and it is the only kind React's error boundary cannot see.
installClientErrorLog();

mountRoot(
  <StrictMode>
    <Provider store={store}>
      <CssBaseline />
      <App />
    </Provider>
  </StrictMode>,
);
