import React from 'react';
import { useEffect, useState } from 'react';
import { Redirect } from 'react-router-dom';
import { getUiType, useApproval, useWalletOld } from 'ui/utils';
import { Spin } from 'ui/component';
import { Approval } from 'background/service/notification';

const SortHat = () => {
  const wallet = useWalletOld();
  const [to, setTo] = useState('');
  // eslint-disable-next-line prefer-const
  let [getApproval] = useApproval();

  const loadView = async () => {
    const UIType = getUiType();
    const isInNotification = UIType.isNotification;
    const isInTab = UIType.isTab;
    const approval: Approval | undefined = await getApproval();
    if (isInNotification && !approval) {
      window.close();
      return;
    }

    if (!(await wallet.isBooted())) {
      setTo('/welcome');
      return;
    }

    if (!(await wallet.isUnlocked())) {
      setTo('/unlock');
      return;
    }

    if (
      (await wallet.hasPageStateCache()) &&
      !isInNotification &&
      !isInTab &&
      !approval
    ) {
      const cache = await wallet.getPageStateCache()!;
      setTo(cache.path + (cache.search || ''));
      return;
    }

    if ((await wallet.getPreMnemonics()) && !isInNotification && !isInTab) {
      setTo('/create-mnemonics');
      return;
    }

    const currentAccount = await wallet.getCurrentAccount();

    if (!currentAccount) {
      setTo('/no-address');
    } else if (approval && isInNotification) {
      setTo('/approval');
    } else {
      setTo('/dashboard');
    }
  };

  useEffect(() => {
    loadView();
  }, []);

  return <Spin spinning={!to}>{to && <Redirect to={to} />}</Spin>;
};

export default SortHat;
