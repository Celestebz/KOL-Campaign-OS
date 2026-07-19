import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import userEvent from '@testing-library/user-event';
import FeishuSubtableMappings from './FeishuSubtableMappings';

const campaigns = [{ id: 7, name: 'Vivatrees EverJoy' }, { id: 9, name: 'Summer Launch' }];
const Harness = ({ initial = [{ campaign_id: 7, table_id: 'tbliXAzgY46zjt3U' }], ...props }) => {
  const [value, setValue] = useState(initial);
  return <FeishuSubtableMappings campaigns={campaigns} value={value} onChange={setValue} {...props} />;
};

beforeAll(() => {
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener: jest.fn(), removeListener: jest.fn(), addEventListener: jest.fn(), removeEventListener: jest.fn(), dispatchEvent: jest.fn() }));
  global.ResizeObserver = global.ResizeObserver || class ResizeObserver { observe() {} unobserve() {} disconnect() {} };
});

test('renders an existing project mapping', () => {
  render(<Harness />);
  expect(screen.getByText('Vivatrees EverJoy')).toBeInTheDocument();
  expect(screen.getByLabelText('飞书子表 ID')).toHaveValue('tbliXAzgY46zjt3U');
});

test('adds and deletes mapping rows', async () => {
  render(<Harness />);
  await userEvent.click(screen.getByRole('button', { name: '添加项目映射' }));
  expect(screen.getAllByLabelText('飞书子表 ID')).toHaveLength(2);
  await userEvent.click(screen.getAllByRole('button', { name: '删除项目映射' })[1]);
  expect(screen.getAllByLabelText('飞书子表 ID')).toHaveLength(1);
});

test('disables projects already selected by another row', async () => {
  render(<Harness />);
  await userEvent.click(screen.getByRole('button', { name: '添加项目映射' }));
  await userEvent.click(screen.getAllByRole('combobox', { name: '系统项目' })[1]);
  await screen.findAllByRole('option', { name: 'Vivatrees EverJoy' });
  const disabledOption = document.querySelector('.ant-select-item-option-disabled');
  expect(disabledOption).toHaveTextContent('Vivatrees EverJoy');
});

test('shows loading failure and disables adding mappings', () => {
  render(<Harness loadError="项目列表加载失败" />);
  expect(screen.getByText('项目列表加载失败')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '添加项目映射' })).toBeDisabled();
});

test('shows row-level validation errors without discarding input', () => {
  render(<Harness initial={[{ campaign_id: null, table_id: 'invalid' }]} />);
  expect(screen.getByText('请选择系统项目')).toBeInTheDocument();
  expect(screen.getByText('Table ID 必须以 tbl 开头')).toBeInTheDocument();
  expect(screen.getByLabelText('飞书子表 ID')).toHaveValue('invalid');
});
