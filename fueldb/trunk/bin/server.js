/**
 * fueldb: a realtime database
 * Copyright(c) 2014 Joris Basiglio <joris.basiglio@wonderfuel.io>
 * MIT Licensed
 */

var manager = require('./manager.js');
var uid = require('./uid.js');
var config = require('../conf/config.json');
var auth = require('./auth.js');
var db = config.inmemory ? require('./memdb.js') : require('./fsdb.js');
var WebSocket = require('ws');
var WebSocketServer = WebSocket.Server;
var fs = require('fs');
var urlParse = require('url');
var qs = require('querystring');
var http = require('http');
var https = require('https');

var functions = {};

var clustFct = ["set","remove"];

var WS_STATE = {};
WS_STATE.CONNECTING = 0;
WS_STATE.OPEN = 1;
WS_STATE.CLOSING = 2;
WS_STATE.CLOSED = 3;

var HTTP_METHOD = {};
HTTP_METHOD.GET = "read";
HTTP_METHOD.PUT = "set";
HTTP_METHOD.DELETE = "remove";
HTTP_METHOD.POST = "browse";

var _requestHandle = function(request, response) {
	if(request.method === "OPTIONS"){
		response.writeHead(200, {"Allow": "HEAD,GET,PUT,DELETE,OPTIONS",
			"Access-Control-Allow-Origin" : "*",
			"Access-Control-Allow-Methods" : "GET,PUT,POST,DELETE",
			"Access-Control-Allow-Headers" : "Content-Type"});
		response.end();
		return;
	}
	var url = urlParse.parse(request.url,true);
	if(auth.verifyHTTP(url,request.method)){
		response.writeHead(403, {"Content-Type": "application/json"});
		response.write({"error": "You are not allowed"});
		response.end();
		return;
	}
	var path = url.pathname.split("/");
	path = path.slice(1,path.length).join(".");
	var obj ={point:path};
	var body = "";
	request.on('data', function (data) {
        body += data;
        if (body.length > 1e6) {
			response.writeHead(413,{'Content-Type' : 'text/plain'}).end();
			request.connection.destroy();
		}
    });
    request.on('end', function () {
		body = qs.parse(body);
		response.writeHead(200, {"Content-Type": "application/json",
			"Access-Control-Allow-Origin" : "*",
			"Access-Control-Allow-Methods" : "GET,PUT,POST,DELETE",
			"Access-Control-Allow-Headers" : "Content-Type"});
		obj.value = body.value;
		if(wscBroker && clustFct.indexOf(HTTP_METHOD[request.method]) !== -1){
			wscBroker.dispatch(JSON.stringify(obj));
		}
		obj = functions[HTTP_METHOD[request.method]](obj);
		if(obj){
			response.write(JSON.stringify(obj));
		}
		response.end();
	});
};

var _httpsRequestHandle = function(request, response) {
	if(request.method === "GET" && (request.url === "" || request.url === "/")){
		var api = fs.readFileSync("../api/fueldb.js",'utf8');
		api = api.replace("xxxxxxxx:xxxx",request.headers.host);
		api = api.replace("\"yyyy\"","true");
		response.writeHead(200, {"Content-Type": "text/javascript"});
		response.write(api);
		response.end();
		return;
	}
	_requestHandle(request, response);
};

var _httpRequestHandle = function(request, response) {
	if(request.method === "GET" && (request.url === "" || request.url === "/")){
		var api = fs.readFileSync("../api/fueldb.js",'utf8');
		api = api.replace("xxxxxxxx:xxxx",request.headers.host);
		api = api.replace("\"yyyy\"","false");
		response.writeHead(200, {"Content-Type": "text/javascript"});
		response.write(api);
		response.end();
		return;
	}
	_requestHandle(request, response);
};

var _wsRequestHandle = function(ws) {
	ws.id = uid.gen();
	console.log("Connection open: "+ws.id);
	ws.allowed = false;
	ws.onPushed = function(msg) {
		if(ws.readyState === WS_STATE.CONNECTING){
			setTimeout(function() {
				ws.onPushed(msg);
			}, 200);
		} else if(ws.readyState === WS_STATE.OPEN) {
			ws.send(JSON.stringify(msg));
		}
	};
	ws.on('message', function(message) {
		var obj = JSON.parse(message);
		obj.point = obj.point ? obj.point.trim() : "";
		if (auth.verifyWS(obj,ws)) {
			ws.onPushed(obj);
			return;
		}
		
		if (obj.type in functions && typeof functions[obj.type] === "function") {
			if(wscBroker && clustFct.indexOf(obj.type) !== -1){
				wscBroker.dispatch(message);
			}
			functions[obj.type](obj, ws);
		}
	});
	ws.on('error', function(message) {
		console.log("Error: "+message);
	});
	ws.on('close', function(code, message) {
		console.log("Connection lost: "+ws.id);
		manager.removeAll(ws.id);
	});
	
	var obj = {};
	if(config.login){
		obj.point = ".REQ_LOGIN";
		obj.value = "A login is required";
		ws.onPushed(obj);
	}else{
		ws.allowed = true;
		obj.point = ".LOGIN_SUCC";
		ws.onPushed(obj);
	}
};

functions.subscribe = function subscribe(obj, ws) {
	manager.add(obj.point, ws);
	var tmp = db.read(obj.point);
	obj.old = {};
	obj.old.value = "";
	obj.old.date = "";
	obj.value = tmp.value;
	obj.date = tmp.date;
	ws.onPushed(obj);
};

functions.unsubscribe = function unsubscribe(obj, ws) {
	manager.remove(obj.point, ws);
};

functions.set = function set(obj, ws) {
	obj.old = db.read(obj.point);
	db.write(obj.point, obj.value);
	obj.date = new Date().toISOString();
	manager.update(obj.point, obj);
};

functions.read = function read(obj, ws) {
	var tmp = db.read(obj.point);
	obj.value = tmp.value;
	obj.date = tmp.date;
	if(ws){
		ws.onPushed(obj);
	}else{
		return obj;
	}
};

functions.browse = function browse(obj, ws) {
	obj.value = db.browse(obj.point);
	if(ws){
		ws.onPushed(obj);
	}else{
		return obj;
	}
};

functions.remove = function remove(obj, ws) {
	db.remove(obj.point);
	manager.removeCascade(obj.point);
};

config.hosts.forEach(function(host){
	var httpServer;
	if (host.ssl) {
		var options = {
			key : fs.readFileSync(host.key),
			cert : fs.readFileSync(host.cert)
		};
		httpServer = https.createServer(options,_httpsRequestHandle);
	}else{
		httpServer = http.createServer(_httpRequestHandle);
	}
	var wsServer = new WebSocketServer({
		server : httpServer
	});
	wsServer.on('connection', _wsRequestHandle);
	httpServer.listen(host.port, host.host);
	console.log('Listening for HTTP'+(host.ssl?'S':'')+'/WS'+(host.ssl?'S':'')+' at IP ' + host.host + ' on port ' + host.port);
});

var wscBroker;
var _connectBroker = function(){
	wscBroker = new WebSocket('ws://'+config.broker.host+':'+config.broker.port+auth.computeBrokerURL());
	wscBroker.on('open', function() {
		console.log("connected to broker");
	});
	wscBroker.on('message', function(data, flags) {
		console.log("From broker: "+data);
		var obj = JSON.parse(data);
		if(obj.error){
			console.log(obj.error);
			return;
		}
		obj.point = obj.point ? obj.point.trim() : "";
		if (obj.type in functions && typeof functions[obj.type] === "function") {
			functions[obj.type](obj, null);
		}
	});
	wscBroker.on('close', function(evt){
		console.log("connection to broker aborted: "+evt);
	});
	wscBroker.dispatch = function(msg){
		wscBroker.send(msg);
	};
};

if(config.broker.enable){
	_connectBroker();
}
var wscBalancer;
var _connectBalancer = function(){
	wscBalancer = new WebSocket('ws://' + config.balancer.host + ':' + config.balancer.port + auth.computeBalancerURL());
	wscBalancer.on('open', function() {
		console.log("connected to balancer");
	});
	wscBalancer.on('message', function(data, flags) {
		console.log("From balancer: " + data);
	});
	wscBalancer.on('close', function(evt) {
		console.log("connection to balancer aborted: " + evt);
	});
};
if(config.balancer.enable){
	_connectBalancer();
}