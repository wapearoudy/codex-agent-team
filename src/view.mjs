import {App,applyHostStyleVariables,applyDocumentTheme} from '@modelcontextprotocol/ext-apps';
import {setupTeamView} from './team-view.mjs';
import packageInfo from '../package.json' with {type:'json'};
const app=new App({name:'Team Workspace',version:packageInfo.version},{});
const team=setupTeamView(app);
app.ontoolresult=r=>{if(r.structuredContent)void team.accept(r.structuredContent);};
let lastHostLocale;
const applyStyles=()=>{const context=app.getHostContext();if(context?.locale&&lastHostLocale!==context.locale){lastHostLocale=context.locale;team.setLanguage(context.locale);}if(context?.theme)applyDocumentTheme(context.theme);if(context?.styles?.variables)applyHostStyleVariables(context.styles.variables);};
app.onhostcontextchanged=applyStyles;
app.onerror=()=>team.disconnect();
app.onteardown=async()=>{team.close();return{};};
void (async()=>{try{await app.connect();applyStyles();await team.connect();}
catch(error){document.getElementById('feedback').textContent='无法连接当前会话：'+error.message;}})();
