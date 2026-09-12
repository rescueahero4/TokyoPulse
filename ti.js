window.addEventListener('DOMContentLoaded' , () => {
/*アプリ・ソーシャルメディア*/
const appWrap = `
<h2 class="heading02 sp_font26">JR-East Train Info</h2>
<section>
	<div class="col2 mb10">
		<div class="cardsBox">
			<div class="dispFlex">
				<p class="mt15 sp_mt10"><img class="auto" src="/train_info/img/app-twitter.svg" width="60" height="60" alt="X"></p>
				<dl class="calc01 ml15">
					<dt class="fontBold font16 mb2p linkBlank02"><a href="https://www.jreast.co.jp/e/t_i/" target="_blank" rel="noopener">X<span class="screen-reader-text">Opens in a new window.</span></a></dt>
					<dd>Train Status Information Official X<br>The JR East service area information will be available on X.</dd>
				</dl>
			</div>
		</div>
		<div class="cardsBox">
			<div class="dispFlex">
				<p class="mt15 sp_mt10"><img class="auto" src="/train_info/img/logo-dokotore.png" width="60" height="60" alt="DOKOTORE"></p>
				<dl class="calc01 ml15">
					<dt class="fontBold font16 mb2p linkBlank02"><a href="https://doko-train.jp/en/" target="_blank" rel="noopener">DOKOTORE<span class="screen-reader-text">Opens in a new window.</span></a></dt>
					<dd>This site provides information on service status, suspensions, timetables, and past delays for 58 local train lines and BRT (bus route) sections, mainly in regional areas</dd>
				</dl>
			</div>
		</div>
	</div>
	<div class="grayBox pt10 pr5 pb10 pl5">
		<ul>
			<li class="linkBlank ml25 sp_ml0"><a href="/train_info/e/qa.html" target="_blank" rel="noopener">Q&amp;A<span class="screen-reader-text">Opens in a new window.</span></a></li>
		</ul>
	</div>
	<p class="mt30">Unauthorized duplication, copying, or distribution on any electromagnetic media of this information is prohibited.</p>
</section>
`;

//繁体字版
const appWrap_tc = `
<section>
	<div class="grayBox pt10 pr5 pb10 pl5">
		<ul>
			<li class="linkBlank ml25 sp_ml0"><a href="/train_info/tc/qa.html" target="_blank" rel="noopener">問與答<span class="screen-reader-text">出現於新視窗。</span></a></li>
		</ul>
	</div>
	<p class="mt30">未經授權禁止複製、抄襲本網站的資訊或將其轉載至任何電磁介質。</p>
</section>
`;

//簡体字版
const appWrap_sc = `
<section>
	<div class="grayBox pt10 pr5 pb10 pl5">
		<ul>
			<li class="linkBlank ml25 sp_ml0"><a href="/train_info/sc/qa.html" target="_blank" rel="noopener">问与答<span class="screen-reader-text">在新窗口打开。</span></a></li>
		</ul>
	</div>
	<p class="mt30">未经授权禁止复制、抄袭本网站的信息或将其转载至任何电磁媒体。</p>
</section>
`;

//韓国語版
const appWrap_kr = `
<section>
	<div class="grayBox pt10 pr5 pb10 pl5">
		<ul>
			<li class="linkBlank ml25 sp_ml0"><a href="/train_info/kr/qa.html" target="_blank" rel="noopener">Q&amp;A<span class="screen-reader-text">새로운 창이 열립니다.</span></a></li>
		</ul>
	</div>
	<p class="mt30">본 정보에 대한 전자기 매체로의 독단적인 복제, 복사 또는 배포를 금지합니다.</p>
</section>
`;


if(document.getElementById('appWrap')) {
	switch(document.body.getAttribute('id')) {
		case 'service_e':
		document.getElementById('appWrap').insertAdjacentHTML('beforeend' , appWrap);
		break;
		case 'service_tc':
		document.getElementById('appWrap').insertAdjacentHTML('beforeend' , appWrap_tc);
		break;
		case 'service_sc':
		document.getElementById('appWrap').insertAdjacentHTML('beforeend' , appWrap_sc);
		break;
		case 'service_kr':
		document.getElementById('appWrap').insertAdjacentHTML('beforeend' , appWrap_kr);
		break;
	}
}

/*TOP SP表示の提供エリア アコーディオン*/
if(window.matchMedia('(max-width:750px)').matches)  {
	const temp_acc_btn = document.getElementsByClassName('accBtn');
	for (let i = 0; i < temp_acc_btn.length; i++) {
		temp_acc_btn[i].addEventListener('click' , (e) => {
			let thisBtn = e.currentTarget;
			if(thisBtn.classList.contains('is-active')) {
				thisBtn.classList.remove('is-active');
				thisBtn.nextElementSibling.classList.remove('is-show');
			} else {
				thisBtn.classList.add('is-active');
				thisBtn.nextElementSibling.classList.add('is-show');
			}
		});
	}
}

/*もっと見るボタンアコーディオン*/
const temp_accMore_btn = document.getElementsByClassName('accMore_btn');
const temp_accMore_cont = document.querySelectorAll('.accMore_cont tbody tr:nth-of-type(n+8)');
for (let i = 0; i < temp_accMore_btn.length; i++) {
	temp_accMore_btn[i].addEventListener('click' , (e) => {
		let thisBtn = e.currentTarget;
		if(thisBtn.classList.contains('is-active')) {
			thisBtn.classList.remove('is-active');
			for (let i = 0; i < temp_accMore_cont.length; i++) {
				temp_accMore_cont[i].classList.remove('is-show');
			}
		} else {
			thisBtn.classList.add('is-active');
			for (let i = 0; i < temp_accMore_cont.length; i++) {
				temp_accMore_cont[i].classList.add('is-show');
			}
		}
	});
}


/*非表示ボタン*/
const temp_accdisp_btn = document.getElementsByClassName('acc_dispBtn');
for (let i = 0; i < temp_accdisp_btn.length; i++) {
	temp_accdisp_btn[i].addEventListener('click' , (e) => {
		let thisBtn = e.currentTarget;
		if(thisBtn.classList.contains('is-active')) {
			thisBtn.classList.remove('is-active');
			thisBtn.nextElementSibling.classList.remove('is-show');
			switch(document.body.getAttribute('id')) {
				case 'service_e':
				thisBtn.getElementsByClassName('accTxt')[0].textContent = 'Display';
				break;
				case 'service_tc':
				thisBtn.getElementsByClassName('accTxt')[0].textContent = '顯示';
				break;
				case 'service_sc':
				thisBtn.getElementsByClassName('accTxt')[0].textContent = '显示';
				break;
				case 'service_kr':
				thisBtn.getElementsByClassName('accTxt')[0].textContent = '표시';
				break;
			}
		} else {
			thisBtn.classList.add('is-active');
			thisBtn.nextElementSibling.classList.add('is-show');
			switch(document.body.getAttribute('id')) {
				case 'service_e':
				thisBtn.getElementsByClassName('accTxt')[0].textContent = 'Hide';
				break;
				case 'service_tc':
				thisBtn.getElementsByClassName('accTxt')[0].textContent = '不顯示';
				break;
				case 'service_sc':
				thisBtn.getElementsByClassName('accTxt')[0].textContent = '不显示';
				break;
				case 'service_kr':
				thisBtn.getElementsByClassName('accTxt')[0].textContent = '비표시';
				break;
			}
		}
	});
}

});

/* すべてが読み込まれたら実行 */
window.addEventListener('load' , () => {
	/*運行情報・運休情報マップ枠*/
	const operation_statusImage = document.getElementById('operation_status_image');
	if(operation_statusImage) {

		// 運行情報・運休情報マップ画像を取得
		const img = new Image();
		img.src = operation_statusImage.getAttribute('src');

		// オリジナルサイズを取得
		const w = img.width;
		const h = img.height;

		// 画像サイズが1x1の場合
		if( w == 1 && h == 1 ) {
			operation_statusImage.classList.add('operation_status_image-none');// 非表示
		} else {// そうでない場合
			operation_statusImage.classList.add('operation_status_image-show');// 表示
		}
	}
});