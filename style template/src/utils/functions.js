import moment from 'moment';
import 'moment/locale/sq';


export function ToDateTime(value){
    return moment(value).locale('sq').format('DD/MM/YYYY hh:mm:ss');
}

export function DateFromNow(value){
    return moment(value).locale('sq').fromNow();
}

export async function ShareAPI(title, text, url){
    if (navigator.share === undefined) {
        console.log('Error: Unsupported feature: navigator.share');
        return;
      }
  
    //   const text = `I'm reading from Kentucky News. Read the article at the original link: ${props.post.title}`
  
      try {
        await navigator.share({title, text, url});
        console.log('Successfully sent share');
      } catch (error) {
        console.log('Error sharing: ' + error);
      }
}

export function isMobile(){
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}