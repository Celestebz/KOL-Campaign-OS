import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import axios from 'axios';
import Settings from './Settings';

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn()
}));

beforeAll(() => {
  window.matchMedia = window.matchMedia || function matchMedia() {
    return {
      matches: false,
      addListener: jest.fn(),
      removeListener: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn()
    };
  };
  global.ResizeObserver = global.ResizeObserver || class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  jest.clearAllMocks();
  axios.get.mockResolvedValue({
    data: {
      data: {
        platforms: {},
        aiModels: {},
        externalAgent: {},
        cloudStorage: {},
        fallbackStrategy: {}
      }
    }
  });
});

test('removes Agent Automation controls while retaining External Agent API and Maton Gateway', async () => {
  render(<Settings />);

  await waitFor(() => {
    expect(screen.queryByText('Agent 自动化')).not.toBeInTheDocument();
    expect(screen.queryByText(/BrowserAct/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Playwright Local/)).not.toBeInTheDocument();
    expect(screen.getByText('External Agent API')).toBeInTheDocument();
    expect(screen.getAllByText('Maton Gateway').length).toBeGreaterThan(0);
  });
});
