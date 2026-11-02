import React from 'react';
import {createRoot} from 'react-dom/client';
import App from './RoleApp.jsx';
import './styles.css';
import './glass.css';
import './prism-theme.css';
class AppBoundary extends React.Component {
  state = {failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?<div className="app-loading"><h1>界面暂时未能加载</h1><p>业务数据已保存在后端。请重新加载页面恢复连接。</p><button className="primary" onClick={()=>window.location.reload()}>重新加载</button></div>:this.props.children;}
}
createRoot(document.getElementById('root')).render(<AppBoundary><App/></AppBoundary>);
