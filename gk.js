/**
	コンテンツ取得
 */
function getInformation() {
	var request = new XMLHttpRequest();
	request.open("get", "https://www.jreast.co.jp/traininfojp/kanto.json", false);
	request.onload = function (event) {
		if (request.readyState === 4) {
			if (request.status === 200) {
				setData(request.responseText); // => "OK"
			} else {
				console.log(request.statusText); // => Error Message
			}
		}
	};
	request.onerror = function (event) {
	  console.log(event.type); // => "error"
	};
	request.send();
}
function setData(data) {
	const json = JSON.parse(data);
	json.sort(function(a,b){return b.metainfo.sort - a.metainfo.sort;});
	space = document.querySelector('.afterwriteinfo');
	var dummyCount=0;
	if(json.length>0){
		var html = '';
			html+='              <section class="container traininfo_info" id="train_noticeBox">';
			html+='                  <section class="contentsWrapper">';
			html+='                  <h2 class="heading02 mb40">お知らせ</h2>';
			html+='                  <ul class="informationBox">';

		for(var i = 0 ;i < json.length; i++){
			if(json[i].metainfo.dummy != "1"){
				var releasedate = json[i].metainfo.release_date;
				var releasetitle = json[i].metainfo.release_title;
				var locate = location.href
				message=json[i].metainfo.infomessage;
				var url = json[i].metainfo.link_name;
				var linktext = json[i].metainfo.link_text;
				var boolPdf=false;
				if(url.length>0){
					var url = "https://www.jreast.co.jp/"+url;
					if(url.indexOf(".pdf") > 0){
						boolPdf=true;
						linktext += "[PDF/"+json[i].metainfo.file_size+"KB]"
					}
				}else{
					var url = "";
				}
				html+='                      <li>';
				html+='                          <p class="date">'+releasedate+'</p>';
				html+='                          <p class="text">'+ message +'</p>';
				if(boolPdf){
				html+='                          <p><span class="pdfLink"><a target="_blank" href="'+url+'">'+linktext+'</a></span></p>';
				}else if(url.length > 0 && linktext.length > 0){
				html+='                          <p><span class="linkBlank"><a href="'+url+'" target="_blank" title="Opens in a new window">'+linktext+'</a></span></p>';
				}
				html+='                      </li>';
			}else{
				dummyCount=dummyCount+1;
			}
		}
			html+='                  </ul>';
			html+='                  </section>';
			html+='              </section>';
	}
	if(json.length > dummyCount){
		space.insertAdjacentHTML('afterend', html);
	}
}

