import * as storage from './storageService';

// localStorage is available in jsdom but we can simulate quota exceeded by
// mocking setItem to throw.

describe('storageService', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.restoreAllMocks();
  });

  it('saves and retrieves values normally', () => {
    storage.SaveValue('foo', { bar: 1 });
    expect(storage.GetValue('foo')).toEqual({ bar: 1 });
  });

  it('does not throw when storage quota exceeded', () => {
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    expect(() => storage.SaveValue('foo', { bar: 1 })).not.toThrow();
    // value should not be stored
    expect(localStorage.getItem('')).toBeNull();
  });
});