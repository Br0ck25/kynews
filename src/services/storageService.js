import Constants from '../constants/constants';

export function SaveValue(name, values) {
  try {
    localStorage.setItem(Constants.localStoragePrefix + name, JSON.stringify(values));
  } catch (err) {
    // quota exceeded or disabled storage; warn but don't propagate so callers
    // can continue using live data.  This prevents a single overflow from
    // breaking article fetches.
    console.warn(`storageService.SaveValue failed for ${name}:`, err);
  }
}

export function GetValue(name) {
  return JSON.parse(localStorage.getItem(Constants.localStoragePrefix + name));
}

export function SavePost(post){
  let savedPost = GetValue('savedPost');
  if(savedPost){
    const postExist = savedPost.filter(item => item.originalLink === post.originalLink).length > 0;
    if(!postExist)
      SaveValue('savedPost', [...savedPost, {...post}]);
  }else{
    SaveValue('savedPost', [{...post}])
  }
}

/**
 * Toggle a Kentucky county in/out of the persisted "saved counties" list.
 * Returns true if the county is now saved, false if it was just removed.
 */
export function ToggleSavedCounty(countyName) {
  const key = 'savedCounties';
  const existing = GetValue(key) || [];
  const alreadySaved = existing.includes(countyName);
  if (alreadySaved) {
    SaveValue(key, existing.filter((c) => c !== countyName));
    return false;
  } else {
    SaveValue(key, [...existing, countyName]);
    return true;
  }
}

/**
 * Returns the list of saved county names from localStorage.
 */
export function GetSavedCounties() {
  return GetValue('savedCounties') || [];
}

// export function GetValues() {
//   let items = [];
//   for (var key in localStorage) {
//     if (key.indexOf("StorageName") === 0) {
//       const item = JSON.parse(localStorage[key]);
//       const arr = { key: key, ...item };
//       items.push(JSON.stringify(arr));
//     }
//   }

//   return items;
// }

export function DeleteValue(name) {
  localStorage.removeItem(Constants.localStoragePrefix + name);
}
