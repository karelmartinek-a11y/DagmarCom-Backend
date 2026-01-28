const { buildOutboundText } = require('../src/queue');

describe('buildOutboundText', () => {
  const settings = {
    outputPrefixFirst: 'A',
    outputPrefixNext: 'B',
    outputPrefixAlways: 'C',
  };

  test('first response', () => {
    const text = buildOutboundText(settings, 0, 'X');
    expect(text).toBe('AXC');
  });

  test('next response', () => {
    const text = buildOutboundText(settings, 2, 'Y');
    expect(text).toBe('BYC');
  });
});
